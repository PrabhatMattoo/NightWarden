import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { isRunning } from "../session/status-store.js";
import { createSession } from "../session/store.js";
import { getTranscriptRows } from "../session/transcript-store.js";
import { fakeModel, type ScriptedTurn } from "./fake-model.js";
import { connectFrontendEvents } from "./frontend-events-helper.js";
import { harness, type Harness, type HarnessRunner } from "./harness.js";
import { svc } from "./manifest-helper.js";
import { messageBody } from "./session-helper.js";
import { waitFor } from "./wait.js";

const scripted = fakeModel();
const setScript = (turns: ScriptedTurn[]): void => scripted.script(turns);

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Found root cause. Investigation complete.",
  toolUses: [],
};

// Set by a test that wants the runner to answer with its own failure, the way
// a real one does when it cannot resolve the target.
let runnerError: string | null = null;

describe("multi-runner routing", () => {
  let nw: Harness;
  let SESSION: string;
  let port: number;
  let web: HarnessRunner;
  let db: HarnessRunner;
  let cache: HarnessRunner;
  let cluster: HarnessRunner;

  beforeAll(async () => {
    const fail = (): string | null => runnerError;
    // The server name doubles as the hostname here: this file is about where a
    // command lands, and router.test.ts is where the two are told apart.
    nw = await harness({
      model: scripted,
      runners: [
        {
          name: "web-01",
          services: ["nginx", "api"],
          answer: () => ({}),
          fail,
        },
        { name: "db-02", services: ["postgres"], answer: () => ({}), fail },
        { name: "cache-01", services: ["redis"], answer: () => ({}), fail },
        {
          name: "k8s-cluster-01",
          platform: "kubernetes",
          services: ["production/api-server"],
          answer: () => ({}),
          fail,
        },
      ],
    });
    ({ port, session: SESSION } = nw);
    [web, db, cache, cluster] = nw.runners as [
      HarnessRunner,
      HarnessRunner,
      HarnessRunner,
      HarnessRunner,
    ];
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    for (const runner of nw.runners) runner.commands.length = 0;
  });

  async function runSession(): Promise<string> {
    const sessionId = randomUUID();
    // The chat route writes the row before dispatching, so that a run always has
    // a session to claim; this drives the dispatcher directly and must do the same.
    await createSession({
      sessionId,
      title: "t",
      createdAt: new Date().toISOString(),
    });
    await nw.dispatcher.dispatch({
      sessionId,
      userMessage: "investigate",
    });
    await waitFor(async () => !(await isRunning(sessionId)));
    return sessionId;
  }

  it("container-targeted command routes to the runner that owns the container", async () => {
    setScript([
      {
        text: "Checking postgres.",
        toolUses: [
          {
            toolCallId: "tu-1",
            name: "GetDockerLogs",
            input: { target: "db-02/postgres/postgres" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(db.commands).toHaveLength(1);
    expect(db.commands[0].commandName).toBe("GetDockerLogs");
    expect(web.commands).toHaveLength(0);
  });

  it("unknown container produces a tool error naming all known containers", async () => {
    setScript([
      {
        text: "Checking unknown service.",
        toolUses: [
          {
            toolCallId: "tu-3",
            name: "GetDockerLogs",
            input: { target: "web-01/ghost-svc/ghost-svc" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const sessionId = await runSession();

    // Neither runner should have executed the command (routing rejected it).
    expect(web.commands).toHaveLength(0);
    expect(db.commands).toHaveLength(0);

    // The error is persisted as a user-turn message in the transcript.
    const messages = await getTranscriptRows(sessionId);
    const errorMsg = messages.find(
      (m) => m.kind === "user" && m.content.includes("ghost-svc"),
    );
    expect(errorMsg?.content).toMatch(/nginx/);
    expect(errorMsg?.content).toMatch(/api/);
    expect(errorMsg?.content).toMatch(/postgres/);
  });

  // A container that is not running is the finding, not a broken tool. It was
  // classed as system, which tells the agent its evidence proves nothing.
  it("names no cause for a target the runner cannot resolve", async () => {
    setScript([
      {
        text: "Reading logs.",
        toolUses: [
          {
            toolCallId: "tu-missing",
            name: "GetDockerLogs",
            input: { target: "web-01/nginx/nginx" },
          },
        ],
      },
      FINISH_TURN,
    ]);
    runnerError = "No running container found for nginx/nginx";
    const sessionId = await runSession();
    runnerError = null;

    const answer = (await getTranscriptRows(sessionId))
      .flatMap((row) => row.parts)
      .find((p) => p.type === "tool_result" && p.toolCallId === "tu-missing");
    expect(answer).toMatchObject({ isError: true });
    // A wrong name and a stopped service reach the runner identically, so the
    // message offers both and asserts neither.
    const said = answer?.type === "tool_result" ? answer.output : "";
    expect(said).toContain("named wrongly");
    expect(said).toContain("not running");
    expect(said).toContain("cannot tell you which");
  });

  it("a host command naming a runner reaches only that runner", async () => {
    setScript([
      {
        text: "Checking db-02 host memory.",
        toolUses: [
          {
            toolCallId: "tu-4",
            name: "GetHostMemory",
            input: { server: ["db-02"] },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(db.commands).toHaveLength(1);
    expect(db.commands[0].commandName).toBe("GetHostMemory");
    expect(web.commands).toHaveLength(0);
  });

  it("a host command naming both hosts reads each and names each answer", async () => {
    setScript([
      {
        text: "Checking host memory.",
        toolUses: [
          {
            toolCallId: "tu-5",
            name: "GetHostMemory",
            input: { server: ["web-01", "db-02"] },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const sessionId = await runSession();

    expect(web.commands).toHaveLength(1);
    expect(db.commands).toHaveLength(1);

    // Each answer is attributed, so the model can tell which host is the sick one.
    const messages = await getTranscriptRows(sessionId);
    const result = messages.find(
      (m) => m.kind === "user" && m.content.includes("byServer"),
    );
    expect(result?.content).toMatch(/web-01/);
    expect(result?.content).toMatch(/db-02/);
  });

  it("approved remediation executes on the runner that owns the target container", async () => {
    setScript([
      {
        text: "Restarting postgres.",
        toolUses: [
          {
            toolCallId: "tu-restart",
            name: "RestartDockerService",
            input: {
              target: "db-02/postgres/postgres",
              reason: "OOM killed",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody("postgres is crashing"),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Wait for the approval interrupt — RestartDockerService is a gated tool.
    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // No runner has executed anything yet (sendCommand only runs after approval).
    expect(web.commands).toHaveLength(0);
    expect(db.commands).toHaveLength(0);

    // Approve — the approve route calls sendCommand with the persisted toolInput
    // (which has service: docker/postgres/postgres), routing it to runner-b.
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(approveRes.status).toBe(200);

    // runner-b owns "postgres" and must receive the restart command.
    await waitFor(() =>
      db.commands.some((c) => c.commandName === "RestartDockerService"),
    );
    expect(
      db.commands.find((c) => c.commandName === "RestartDockerService")
        ?.commandInput["service"],
    ).toEqual(svc("postgres"));
    expect(web.commands).toHaveLength(0);

    close();
  });

  it("kubernetes service identity routes to the Kubernetes runner", async () => {
    setScript([
      {
        text: "Checking Kubernetes api-server.",
        toolUses: [
          {
            toolCallId: "tu-k8s",
            name: "GetK8sLogs",
            input: { target: "k8s-cluster-01/production/api-server" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(cluster.commands).toHaveLength(1);
    expect(cluster.commands[0].commandName).toBe("GetK8sLogs");
    expect(web.commands).toHaveLength(0);
    expect(db.commands).toHaveLength(0);
    expect(cache.commands).toHaveLength(0);
  });
});
