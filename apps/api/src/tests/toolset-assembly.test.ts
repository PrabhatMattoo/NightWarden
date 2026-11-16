import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOL_NAMES, type Platform } from "@nightwarden/shared";
import { runSession } from "../agent/loop/run-session.js";
import { buildChatContext } from "../agent/context.js";
import { connectedPlatforms } from "../agent/policy.js";
import { REPORT } from "../agent/prompts/report.js";
import { IDENTITY, INVESTIGATION } from "../agent/prompts/system.js";
import { effectiveToolset, getToolSchemas } from "../agent/tools/toolset.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../fleet/connections.js";
import {
  deleteLokiIntegration,
  saveLokiIntegration,
} from "../integrations/store.js";
import { isRunning } from "../session/status-store.js";
import { fakeAnthropic } from "./fake-anthropic.js";
import {
  messagesSentTo,
  toolsSentTo,
  type ScriptedTurn,
} from "./fake-model.js";
import { connectFrontendEvents } from "./frontend-events-helper.js";
import { harness, type Harness } from "./harness.js";
import { manifest } from "./manifest-helper.js";
import { messageBody, seedChatSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";

const anthropic = fakeAnthropic();
const setScript = (turns: ScriptedTurn[]): void => anthropic.script(turns);

describe("toolset assembly by fleet capabilities", () => {
  describe("provider library injection (unit)", () => {
    /* The prompt assertions below read the connected metrics sources, so without
       this the suite opens the real ~/.nightwarden database. */
    let cleanupDb: () => void;
    beforeAll(async () => {
      cleanupDb = await useTempDb();
    });
    afterAll(() => cleanupDb());

    // Platform comes from the runner's row, so there is no handshake window in
    // which the fleet's platforms are unknown.
    it("knows a runner's platform from the moment it connects, before any manifest", () => {
      expect(connectedPlatforms()).toEqual(new Set([]));

      const conn = registerRunner({
        runnerId: "caps-unit-docker",
        platform: "docker",
        serverName: "caps-unit",
        send: () => {},
        close: () => {},
      });
      expect(connectedPlatforms()).toEqual(new Set(["docker" as const]));

      setRunnerManifest("caps-unit-docker", manifest("caps-unit-host", []));
      expect(connectedPlatforms()).toEqual(new Set(["docker" as const]));

      unregisterRunner(conn);
      expect(connectedPlatforms()).toEqual(new Set([]));
    });

    it("offers both provider libraries when capabilities are unknown", () => {
      const names = getToolSchemas().map((s) => s.name);
      expect(names).toContain("GetDockerLogs");
      expect(names).toContain("GetK8sLogs");
      expect(names).toContain("RestartDockerService");
      expect(names).toContain("RestartK8sWorkload");
    });

    it("a Docker-only fleet gets Docker tools and no Kubernetes tools", () => {
      const names = getToolSchemas(new Set(["docker" as const])).map(
        (s) => s.name,
      );
      expect(names).toContain("GetDockerLogs");
      expect(names).toContain("ListDockerServices");
      expect(names).toContain("RestartDockerService");
      expect(names).toContain("DockerExec");
      expect(names).not.toContain("GetK8sLogs");
      expect(names).not.toContain("GetK8sRolloutStatus");
      expect(names).not.toContain("GetK8sNodeStatus");
      expect(names).not.toContain("RestartK8sWorkload");
    });

    it("a Kubernetes-only fleet gets Kubernetes tools and no Docker tools", () => {
      const names = getToolSchemas(new Set(["kubernetes" as const])).map(
        (s) => s.name,
      );
      expect(names).toContain("GetK8sLogs");
      expect(names).toContain("ListK8sWorkloads");
      expect(names).toContain("GetK8sRolloutStatus");
      expect(names).toContain("GetK8sNodeStatus");
      expect(names).toContain("RestartK8sWorkload");
      expect(names).not.toContain("GetDockerLogs");
      expect(names).not.toContain("RestartDockerService");
    });

    it("host tools live in the Docker library: absent on a Kubernetes-only fleet", () => {
      const hostTools = [
        "GetHostMemory",
        "GetHostCPU",
        "GetHostDisk",
        "GetHostNetwork",
        "GetHostDmesg",
        "ReadHostFile",
      ];
      const dockerNames = getToolSchemas(new Set(["docker" as const])).map(
        (s) => s.name,
      );
      const k8sNames = getToolSchemas(new Set(["kubernetes" as const])).map(
        (s) => s.name,
      );
      for (const name of hostTools) {
        expect(dockerNames).toContain(name);
        expect(k8sNames).not.toContain(name);
      }
    });

    it("the GitHub gate controls both the repo tools and ListRecentGitChanges", () => {
      const connected = getToolSchemas(undefined, { github: true }).map(
        (s) => s.name,
      );
      expect(connected).toContain("ListRecentGitChanges");
      expect(connected).toContain("OpenPullRequest");
      const disconnected = getToolSchemas(undefined, {
        github: false,
      }).map((s) => s.name);
      expect(disconnected).not.toContain("ListRecentGitChanges");
      expect(disconnected).not.toContain("OpenPullRequest");
      expect(disconnected).not.toContain("Read");
    });

    it("ListRecentGitChanges is offered with no runner platform at all", () => {
      const names = getToolSchemas(new Set([]), {
        github: true,
      }).map((s) => s.name);
      expect(names).toContain("ListRecentGitChanges");
      expect(names).not.toContain("GetDockerLogs");
      expect(names).not.toContain("GetK8sLogs");
    });

    it("the metrics gate controls the metrics tools, independent of platform", () => {
      const connected = getToolSchemas(new Set([]), {
        github: false,
        metrics: true,
      }).map((s) => s.name);
      expect(connected).toContain("QueryMetrics");
      expect(connected).toContain("QueryMetricsRange");
      const disconnected = getToolSchemas(undefined, {
        metrics: false,
      }).map((s) => s.name);
      expect(disconnected).not.toContain("QueryMetrics");
      expect(disconnected).not.toContain("QueryMetricsRange");
    });

    it("the Loki gate controls the log tools, independent of platform", () => {
      const connected = getToolSchemas(new Set([]), {
        github: false,
        metrics: false,
        loki: true,
      }).map((s) => s.name);
      expect(connected).toContain("QueryLogs");
      expect(connected).toContain("QueryLogMetrics");
      expect(connected).toContain("DiscoverLogLabels");
      const disconnected = getToolSchemas(undefined, { loki: false }).map(
        (s) => s.name,
      );
      expect(disconnected).not.toContain("QueryLogs");
      expect(disconnected).not.toContain("QueryLogMetrics");
      expect(disconnected).not.toContain("DiscoverLogLabels");
    });

    // The record belongs to the investigation, and nothing offered to a chat
    // can start one: what a session is was settled before the run began.
    it("offers the record's tool to an investigation and to nothing else", () => {
      const plain = effectiveToolset(new Set([]), {}, false).tools.map(
        (t) => t.schema.name,
      );
      expect(plain).not.toContain("RecordFinding");

      const investigating = effectiveToolset(new Set([]), {}, true).tools.map(
        (t) => t.schema.name,
      );
      expect(investigating).toContain("RecordFinding");
      // The report turn's tool is the loop's to attach, never the
      // toolset's: offered here it would let a run write itself up mid-work.
      expect(investigating).not.toContain("ComposeReport");
    });

    // The prompt named eleven tools and a run with no runner asked for every
    // one. A description arrives with its tool, so nothing here may name one.
    it("never names a tool it is not offering", () => {
      for (const investigation of [true, false]) {
        for (const github of [true, false]) {
          for (const platforms of [
            new Set<Platform>(),
            new Set(["docker" as Platform]),
          ]) {
            const offered = effectiveToolset(
              platforms,
              { github, metrics: false, loki: false },
              investigation,
            );
            const prompt = buildChatContext(
              [],
              {
                budgetMinutes: 30,
                repo: github ? "acme/api" : null,
                fleetTools: offered.tools.some((t) => t.on === "runner"),
              },
              investigation,
            ).systemPrompt;

            const offeredNames = new Set(
              offered.tools.map((t) => t.schema.name),
            );
            // Compound names only: Read, Edit, Write and Bash are English words
            // this prose uses, and no substring match can tell them apart.
            const namedButNotOffered = TOOL_NAMES.filter(
              (name) =>
                /[a-z][A-Z]/.test(name) &&
                prompt.includes(name) &&
                !offeredNames.has(name),
            );
            expect(namedButNotOffered).toEqual([]);

            // Same rule for the block a description points at: with no runner
            // the fleet summary is never rendered, so nothing may cite it.
            expect(prompt.includes("<servers>")).toBe(
              offeredNames.size > 0 &&
                offered.tools.some((t) => t.on === "runner"),
            );
          }
        }
      }
    });

    /* One base and one section, so a rule stated twice is one two wordings can
       drift apart. Counted rather than found, which the duplication survived. */
    it("states each shared rule exactly once, whichever session it is for", () => {
      const opts = { budgetMinutes: 30, repo: null, fleetTools: false };
      const shared = [
        "You are NightWarden, a reliability engineer",
        "a measured value, a file path, a container, a commit, or a log line",
        "Check database connectivity",
        "Never invent an answer you cannot support",
        "The tools listed for you are the only tools you have",
        "wrapped in a <system-reminder> tag",
      ];
      for (const investigation of [true, false]) {
        const prompt = buildChatContext([], opts, investigation).systemPrompt;
        for (const rule of shared) {
          expect(prompt.split(rule)).toHaveLength(2);
        }
      }
    });

    /* The section is the only difference, so what belongs to an investigation is
       absent from a chat rather than contradicted. Asserted whole, not textually. */
    it("gives a chat none of the investigation's framing", () => {
      const opts = { budgetMinutes: 30, repo: null, fleetTools: false };
      const chat = buildChatContext([], opts, false).systemPrompt;
      const investigating = buildChatContext([], opts, true).systemPrompt;

      for (const section of [INVESTIGATION, REPORT]) {
        expect(investigating).toContain(section);
        expect(chat).not.toContain(section);
      }
      // Everything a chat is, an investigation is too: it adds, never replaces.
      expect(investigating).toContain(IDENTITY);
      expect(chat).toContain(IDENTITY);
      expect(chat).not.toMatch(/investigat/i);
    });
  });

  describe("a chat through the loop", () => {
    let nw: Harness;
    let port: number;
    let SESSION: string;

    beforeAll(async () => {
      nw = await harness({ model: anthropic });
      ({ port, session: SESSION } = nw);
    });

    afterAll(async () => {
      await nw.close();
      vi.unstubAllEnvs();
    });

    // Nothing the model can call opens an investigation, so the report tools
    // stay absent for every turn of this run and every run after it.
    it("never gives a chat the report tools, on any turn or any later run", async () => {
      const first = anthropic.requests.length;
      setScript([
        {
          text: "Let me look.",
          toolUses: [
            { toolCallId: "tu-look-1", name: "ListDockerServices", input: {} },
          ],
        },
        { text: "Redis is fine.", toolUses: [] },
      ]);

      const { events, close } = await connectFrontendEvents(port, SESSION);

      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: messageBody("Why does redis keep restarting?"),
      });
      const { sessionId } = (await res.json()) as { sessionId: string };

      await waitFor(() =>
        events.find(
          (e) =>
            e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
        ),
      );
      close();

      // Paging is offered on every turn, so its presence proves the list is the toolset.
      for (const turn of [first, first + 1]) {
        expect(toolsSentTo(anthropic, turn)).toContain("ReadToolResult");
        expect(toolsSentTo(anthropic, turn)).not.toContain("RecordFinding");
      }

      // And across runs: a follow-up on the same chat is still a chat.
      setScript([{ text: "Nothing has changed.", toolUses: [] }]);
      await waitFor(async () => !(await isRunning(sessionId)));

      const resumed = anthropic.requests.length;
      const followUp = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${SESSION}`,
          },
          body: messageBody("Anything else?"),
        },
      );
      expect(followUp.status).toBe(202);
      await waitFor(async () => !(await isRunning(sessionId)));

      expect(toolsSentTo(anthropic, resumed)).toContain("ReadToolResult");
      expect(toolsSentTo(anthropic, resumed)).not.toContain("RecordFinding");
    });
  });

  /* The toolset is re-read every turn, so it can change under a running model.
     Told nothing, the model reads that as the rules having moved. */
  describe("a toolset that changes mid-run", () => {
    let cleanupDb: () => void;
    beforeAll(async () => {
      cleanupDb = await useTempDb();
    });
    afterAll(() => cleanupDb());

    it("names what appeared, and offers it on the turn after", async () => {
      /* Connected while the first turn is in flight, between the two reads of
         the toolset, where a user connecting Loki in another tab would land. */
      let inFlight = 0;
      anthropic.park(async () => {
        if (inFlight++ > 0) return;
        await saveLokiIntegration({
          baseUrl: "http://loki.internal:3100",
          orgId: null,
          authorization: null,
        });
      });
      const first = anthropic.requests.length;
      setScript([
        {
          text: "",
          toolUses: [
            { toolCallId: "tu-a", name: "ListDockerServices", input: {} },
          ],
        },
        { text: "Done.", toolUses: [] },
      ]);

      const sessionId = randomUUID();
      await seedChatSession(sessionId, "what is running?");
      await runSession(
        { sessionId, userMessage: "what is running?" },
        anthropic.fetch,
      );
      anthropic.park();

      const told = messagesSentTo(anthropic, first + 1)
        .flatMap((m) => m.texts)
        .find((c) => c.includes("connected while you were working"));
      expect(told, "the model was never told").toBeDefined();
      expect(told).toContain("QueryLogs");

      // And the tool is actually on the next request, not only announced.
      expect(toolsSentTo(anthropic, first + 1)).toContain("QueryLogs");

      await deleteLokiIntegration();
    });
  });
});
