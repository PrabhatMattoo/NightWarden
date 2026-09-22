import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createContractFakeProvider } from "./contract-fake-provider.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import type { NormalizedAlert } from "@nightwarden/shared";
import type { ProviderMessage } from "../llm/types.js";
import { runSession, buildSessionMeta } from "../agent/loop/run-session.js";
import { getRecord } from "../session/record-store.js";
import {
  openCandidateIds,
  standingFindings,
  supersededIds,
} from "@nightwarden/shared";
import { buildTranscript } from "../session/transcript.js";
import { seedAlertSession } from "./session-helper.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../fleet/connections.js";
import { resolveCommand } from "../fleet/transport.js";
import { generateRunnerToken } from "../fleet/runners-store.js";
import { manifest } from "./manifest-helper.js";
import { useTempDb } from "./temp-db.js";

function alert(sourceAlertId: string): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    alertType: "HighLatency",
    firedAt: new Date().toISOString(),
    annotations: {},
    generatorURL: null,
    values: {},
  };
}

describe("candidates, the frontier and falsification", () => {
  async function connectRunner() {
    const runnerId = (await generateRunnerToken("docker", "cand-host")).id;
    const conn = registerRunner({
      runnerId,
      platform: "docker",
      serverName: "cand-host",
      send: (raw: string) => {
        const msg = JSON.parse(raw) as { payload: { correlationId: string } };
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [],
        });
      },
      close: () => {},
    });
    setRunnerManifest(runnerId, manifest("cand-host"));
    return conn;
  }

  let cleanupDb: () => void;
  let runner: ReturnType<typeof registerRunner>;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
  });
  afterAll(() => cleanupDb());
  beforeEach(async () => {
    mockCreateProvider.mockReset();
    runner = await connectRunner();
  });
  afterEach(() => unregisterRunner(runner));

  const readTurn = () => ({
    toolUses: [
      {
        toolCallId: `tu-read-${randomUUID()}`,
        name: "ListDockerServices",
        input: { server: ["cand-host"] },
      },
    ],
    text: "",
  });

  const openTurn = (
    candidates: Array<{
      statement: string;
      ifTrue: string;
      ifFalse: string;
      parent?: string;
    }>,
  ) => ({
    toolUses: [
      {
        toolCallId: `tu-open-${randomUUID()}`,
        name: "OpenCandidates",
        input: { candidates },
      },
    ],
    text: "",
  });

  // Cites e2 by default: a finding rests on a result gathered after the
  // candidate opened, and e1 is the gathering read that opened it.
  const findingTurn = (
    verdict: string,
    statement: string,
    extra: { candidate?: string; evidenceId?: string } = {},
  ) => {
    const { evidenceId = "e2", ...rest } = extra;
    return {
      toolUses: [
        {
          toolCallId: `tu-find-${randomUUID()}`,
          name: "RecordFinding",
          input: {
            statement,
            verdict,
            explanation: "what the read showed",
            evidenceIds: [evidenceId],
            ...rest,
          },
        },
      ],
      text: "",
    };
  };

  // How a run says it has finished, which used to be silence. A fresh id per
  // call, because a result is read back by the id its call carried.
  const closeTurn = () => ({
    toolUses: [
      {
        toolCallId: `tu-close-${randomUUID()}`,
        name: "CloseInvestigation",
        input: {},
      },
    ],
    text: "",
  });
  // The one turn the reader is addressed in, after the write-up, with no tools.
  const closingTurn = { toolUses: [], text: "The write-up is ready." };
  const submitTurn = {
    toolUses: [
      {
        toolCallId: "tu-submit",
        name: "ComposeReport",
        input: {
          headline: "checkout slowed under a saturated pool",
          affected: "the checkout path",
          summary: "the pool was exhausted",
          timeline: [],
          impact: "a few minutes of slow checkouts",
          recommendation: "raise the pool ceiling",
        },
      },
    ],
    text: "",
  };

  const POOL = {
    statement: "the connection pool was exhausted",
    ifTrue: "pool_in_use pinned at its ceiling across the slowdown",
    ifFalse: "pool_in_use had headroom during the slowdown",
  };
  const PG = {
    statement: "postgres was slow",
    ifTrue: "query p99 climbed with the alert",
    ifFalse: "query p99 stayed flat across the window",
  };

  function harnessMessages(index = 0): string[] {
    const provider = mockCreateProvider.mock.results[index]!.value as {
      chat: ReturnType<typeof vi.fn>;
    };
    const calls = provider.chat.mock.calls as Array<[ProviderMessage[]]>;
    const opening = calls[0]?.[0]?.length ?? 0;
    return (calls.at(-1)?.[0] ?? [])
      .slice(opening)
      .filter(
        (m) => m.role === "user" && m.parts.every((p) => p.type === "text"),
      )
      .map((m) => m.content);
  }

  async function start(id: string): Promise<void> {
    await seedAlertSession(buildSessionMeta(id, null, undefined), [alert(id)]);
    await runSession({ sessionId: id, alerts: [alert(id)] });
  }

  it("forces candidates after the first read, and keeps the open ones in view", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        readTurn(),
        findingTurn("root_cause", POOL.statement, { candidate: "c1" }),
        findingTurn("disproven", PG.statement, { candidate: "c2" }),
        closeTurn(),
        submitTurn,
        closingTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const record = (await getRecord(id))!;
    expect(record.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(record.findings.map((f) => f.candidate)).toEqual(["c1", "c2"]);
    expect(openCandidateIds(record)).toEqual([]);
    expect(record.report).not.toBeNull();

    // The frontier speaks each time the open set changes: both open, then c2 alone.
    const frontier = harnessMessages().filter((m) => m.includes("Still open:"));
    expect(frontier.length).toBeGreaterThanOrEqual(2);
    expect(frontier[0]).toContain("c1");
    expect(frontier[0]).toContain("c2");
  });

  it("refuses a close that races candidates opened in the same turn", async () => {
    // Falsification opens deeper candidates and closes in one turn: the record
    // tools run in order, so the close sees the new candidates and names them.
    const mixed = () => ({
      toolUses: [
        {
          toolCallId: `tu-open-${randomUUID()}`,
          name: "OpenCandidates",
          input: {
            candidates: [
              {
                statement: "the pool ceiling was set too low",
                ifTrue: "the ceiling sits below peak demand",
                ifFalse: "the ceiling sits above peak demand",
              },
              {
                statement: "a client leaked connections",
                ifTrue: "one client holds connections it never returns",
                ifFalse: "every client returns its connections",
              },
            ],
          },
        },
        {
          toolCallId: `tu-close-${randomUUID()}`,
          name: "CloseInvestigation",
          input: {},
        },
      ],
      text: "",
    });
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        readTurn(),
        findingTurn("root_cause", POOL.statement, { candidate: "c1" }),
        findingTurn("disproven", PG.statement, { candidate: "c2" }),
        mixed(),
        readTurn(),
        findingTurn("disproven", "the pool ceiling was set too low", {
          candidate: "c3",
          evidenceId: "e3",
        }),
        findingTurn("disproven", "a client leaked connections", {
          candidate: "c4",
          evidenceId: "e3",
        }),
        closeTurn(),
        submitTurn,
        closingTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    /* The gap reaches the model where it asked: the refusal is the close call's
       own answer, naming the candidate still open, and the run carries on. */
    const refusals: string[] = [];
    for (const item of await buildTranscript(id)) {
      if (item.kind !== "tool_call") continue;
      if (item.toolName !== "CloseInvestigation") continue;
      if (item.state.phase !== "complete") continue;
      if (typeof item.state.result !== "string") continue;
      refusals.push(item.state.result);
    }
    const named = refusals.filter((result) =>
      result.includes("candidates you have not settled"),
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("c3");
    expect((await getRecord(id))!.report).not.toBeNull();
  });

  /* The order the reader needs: the write-up is filed, and only then is the
     model given a turn with no tools to speak in. Silence used to do both. */
  it("files the write-up before it speaks, and speaks with no tools offered", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        readTurn(),
        findingTurn("root_cause", POOL.statement, { candidate: "c1" }),
        findingTurn("disproven", PG.statement, { candidate: "c2" }),
        closeTurn(),
        submitTurn,
        closingTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const provider = mockCreateProvider.mock.results[0]!.value as {
      chat: ReturnType<typeof vi.fn>;
    };
    const offered = provider.chat.mock.calls.map((call) =>
      (call[1] as Array<{ name: string }>).map((t) => t.name),
    );
    // The write-up turn offers one tool; the turn after it offers none.
    expect(offered.at(-2)).toEqual(["ComposeReport"]);
    expect(offered.at(-1)).toEqual([]);

    // And the report exists by the time those closing words are asked for.
    const reminders = harnessMessages().filter((m) =>
      m.includes("Your report is written"),
    );
    expect(reminders).toHaveLength(1);
    expect((await getRecord(id))!.report).not.toBeNull();
  });

  it("draws the board live and keeps a row for each finding it records", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        readTurn(),
        findingTurn("root_cause", POOL.statement, { candidate: "c1" }),
        findingTurn("disproven", PG.statement, { candidate: "c2" }),
        closeTurn(),
        submitTurn,
        closingTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const items = await buildTranscript(id);
    const board = items.find((i) => i.kind === "candidate_card");
    if (board === undefined || board.kind !== "candidate_card") {
      throw new Error("no candidate board in the transcript");
    }
    expect(board.rows.map((r) => [r.statement, r.state])).toEqual([
      [POOL.statement, "root_cause"],
      [PG.statement, "disproven"],
    ]);
    /* Both calls keep their row: committing to what to test is work too, and
       dropping the opening leaves two blocks of reasoning unexplained. */
    const toolNames = items.flatMap((i) =>
      i.kind === "tool_call" ? [i.toolName] : [],
    );
    expect(toolNames.filter((n) => n === "OpenCandidates")).toHaveLength(1);
    expect(toolNames.filter((n) => n === "RecordFinding")).toHaveLength(2);
    // Drawn once, beside the call that opened the set rather than after it.
    expect(items.filter((i) => i.kind === "candidate_card")).toHaveLength(1);
  });

  it("runs a falsification turn naming every candidate before the report", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        readTurn(),
        findingTurn("root_cause", POOL.statement, { candidate: "c1" }),
        findingTurn("disproven", PG.statement, { candidate: "c2" }),
        closeTurn(),
        submitTurn,
        closingTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const table = harnessMessages().find((m) =>
      m.includes("test your own conclusions"),
    );
    expect(table).toBeDefined();
    expect(table).toContain("c1");
    expect(table).toContain("c2");
    expect(table).toContain("would disprove");
  });

  it("lets a later finding about one candidate carry the verdict that stands", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        readTurn(),
        findingTurn("trigger", POOL.statement, { candidate: "c1" }),
        findingTurn("disproven", PG.statement, { candidate: "c2" }),
        findingTurn("root_cause", POOL.statement, { candidate: "c1" }),
        closeTurn(),
        submitTurn,
        closingTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const record = (await getRecord(id))!;
    // Three findings, two candidates, and c1 speaks once with its newest verdict.
    expect(record.findings).toHaveLength(3);
    expect(openCandidateIds(record)).toEqual([]);
    expect(
      standingFindings(record.findings).map((f) => [f.candidate, f.id]),
    ).toEqual([
      ["c1", "f3"],
      ["c2", "f2"],
    ]);
    expect(supersededIds(record.findings)).toEqual(new Set(["f1"]));
  });

  it("stands down without a report when a candidate is never settled", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        readTurn(),
        findingTurn("root_cause", POOL.statement, { candidate: "c1" }),
        // Asked three times for c2, answering each with prose instead.
        closeTurn(),
        closeTurn(),
        closeTurn(),
        closeTurn(),
        closeTurn(),
      ]),
    );
    const id = randomUUID();
    await start(id);

    const record = (await getRecord(id))!;
    expect(openCandidateIds(record)).toEqual(["c2"]);
    // The write-up would claim coverage of c2 that the run never performed.
    expect(record.report).toBeNull();
  });
});
