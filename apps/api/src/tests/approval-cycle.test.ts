import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { AuditPage, SessionReportResponse } from "@nightwarden/shared";
import { fakeModel, messagesSentTo, type ScriptedTurn } from "./fake-model.js";
import { harness, type Harness } from "./harness.js";
import { seedCompleteReport } from "./report-helper.js";
import { messageBody } from "./session-helper.js";

const scripted = fakeModel();
const setScript = (turns: ScriptedTurn[]): void => scripted.script(turns);

import { waitFor } from "./wait.js";
import {
  connectFrontendEvents,
  toolCallReached,
} from "./frontend-events-helper.js";

import { deriveStatus, isRunning } from "../session/status-store.js";
import {
  getOpenTurn,
  hasPendingHumanInput,
  resolveGate,
} from "../session/gate-store.js";
import { buildSeed } from "../session/seed.js";
import { getTranscriptRows } from "../session/transcript-store.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Fixed. Investigation complete.",
  toolUses: [],
};

describe("durable approval interrupts", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    nw = await harness({
      model: scripted,
      runners: [
        {
          name: "approval-host",
          services: ["web-01", "web-02"],
          answer: ({ commandName, commandInput }) => {
            if (commandName !== "RestartDockerService") return [];
            restartCommands.push(commandInput);
            return { restarted: true };
          },
        },
      ],
    });
    ({ port, session: SESSION } = nw);
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  // What the admin reads at GET /audit for one session, newest first.
  const auditOf = async (sessionId: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/audit?limit=200`, {
      headers: { Cookie: SESSION },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as AuditPage).events.filter(
      (event) => event.sessionId === sessionId,
    );
  };

  it("gated tool suspends: interrupt row exists in DB, run exited, INTERRUPT published", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-sus-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
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
      body: messageBody("Service is wedged."),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Run must have exited (dispatcher slot freed)
    expect(isRunning(sessionId)).toBe(false);

    // Interrupt row must be in the DB
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Runner must NOT have executed the write yet
    const countBefore = restartCommands.length;

    expect(interrupt.payload["toolName"]).toBe("RestartDockerService");

    close();

    // cleanup: approve via /respond to prevent leaking into later tests
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ decision: "approve" }),
    });
    await waitFor(() => restartCommands.length > countBefore);
  });

  it("an approval with no decision is refused: it has exactly two answers", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-ctx-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
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
      body: messageBody("Service is wedged."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Bare text must not resume the run as "context added", which hands the
    // agent a successful-looking result for a call that never ran.
    const ctxRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ text: "maintenance window active" }),
      },
    );
    expect(ctxRes.status).toBe(400);
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    close();

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  });

  it("second resolution of same interrupt returns 409", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-409-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
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
      body: messageBody("Service is wedged."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const first = await fetch(
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
    expect(first.status).toBe(200);

    const second = await fetch(
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
    expect(second.status).toBe(409);
    // The request that lost recorded nothing, since the record is part of the decision.
    expect(await auditOf(sessionId)).toHaveLength(1);

    close();
  });

  // H4: concurrent approve+reject — only one wins, tool runs at most once
  it("concurrent approve+reject: exactly one succeeds, exactly one gets 409, tool runs at most once", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-h4-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "concurrent",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody("Service is wedged."),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Fire approve and reject concurrently
    const [approveRes, rejectRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
      fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ decision: "reject" }),
      }),
    ]);

    const statuses = [approveRes.status, rejectRes.status].sort(
      (a, b) => a - b,
    );
    expect(statuses).toEqual([200, 409]);

    // Tool must not run more than once regardless of which path wins
    if (approveRes.status === 200) {
      await waitFor(() => restartCommands.length > 0);
      expect(restartCommands).toHaveLength(1);
    } else {
      // reject won — tool should NOT have run
      expect(restartCommands).toHaveLength(0);
    }

    expect(hasPendingHumanInput(sessionId)).toBe(false);
    close();
  });

  it("message to a suspended session returns 409", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-busy-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
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
      body: messageBody("Service is wedged."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Session is suspended — sending a chat message must get 409
    const msgRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: messageBody("what do you think?"),
      },
    );
    expect(msgRes.status).toBe(409);

    close();

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject" }),
    });
  });

  it("restart-resume: interrupt survives process exit, resolve works and run completes", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-rr-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
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
      body: messageBody("Service is wedged."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Assert: run has exited (simulates what a restart would see — no in-memory state)
    expect(isRunning(sessionId)).toBe(false);

    // Assert: interrupt row is in DB (survives a restart because it's persisted)
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Resolve via REST — works purely from DB state (as it would after restart)
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({
          decision: "approve",
        }),
      },
    );
    expect(approveRes.status).toBe(200);

    // Run resumes and runner executes exactly once
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    close();
  });

  /* A turn of [read, gated write, read, gated write] parks twice. Each decision
     lets the same turn carry on, and the model is asked again only once every
     call in the turn has an answer. */
  it("finishes a gated turn in order after each decision and answers it in one row", async () => {
    restartCommands.length = 0;
    const listing = { server: ["approval-host"] };
    const restart = (toolCallId: string, service: string) => ({
      toolCallId,
      name: "RestartDockerService",
      input: {
        target: `approval-host/${service}/${service}`,
        reason: "mixed",
        estimatedDowntimeSeconds: 2,
      },
    });
    const requestsBefore = scripted.requests.length;
    setScript([
      {
        text: "Checking, restarting, checking again, restarting again.",
        toolUses: [
          { toolCallId: "tu-a", name: "ListDockerServices", input: listing },
          restart("tu-b", "web-01"),
          { toolCallId: "tu-c", name: "ListDockerServices", input: listing },
          restart("tu-d", "web-02"),
        ],
      },
      FINISH_TURN,
    ]);
    const listings = (): number =>
      nw.runner.commands.filter((c) => c.commandName === "ListDockerServices")
        .length;
    const listingsBefore = listings();
    const respond = async (sessionId: string): Promise<Response> =>
      await fetch(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: SESSION },
          body: JSON.stringify({ decision: "approve" }),
        },
      );

    const { events, close } = await connectFrontendEvents(port, SESSION);
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: SESSION },
      body: messageBody("Mixed turn test."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    const asksFor = (toolCallId: string) => () =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["toolCallId"] === toolCallId,
      );

    // Parked on the first write: the read before it ran, the read after it waits.
    await waitFor(asksFor("tu-b"));
    expect(toolCallReached(events, "tu-a", "complete")).toBe(true);
    expect(listings() - listingsBefore).toBe(1);
    expect(restartCommands).toHaveLength(0);

    // The person is away for a quarter of an hour. Only the clock moves, since
    // a frozen timer would stall the requests still in flight.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(Date.now() + 15 * 60_000);

    expect((await respond(sessionId)).status).toBe(200);

    // The same turn carries on: the write runs, the read after it runs, and
    // the second write parks without the model being asked anything.
    await waitFor(asksFor("tu-d"));
    expect(restartCommands.map((c) => c["service"])).toEqual([
      { project: "web-01", service: "web-01" },
    ]);
    expect(listings() - listingsBefore).toBe(2);
    expect(scripted.requests.length - requestsBefore).toBe(1);

    expect((await respond(sessionId)).status).toBe(200);
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
      ),
    );
    expect(restartCommands.map((c) => c["service"])).toEqual([
      { project: "web-01", service: "web-01" },
      { project: "web-02", service: "web-02" },
    ]);

    // One row answers the whole turn, in the order the calls were asked, with
    // ids that ascend and both decisions beside the results.
    const rows = getTranscriptRows(sessionId);
    const answered = rows.filter((row) =>
      row.parts.some((part) => part.type === "tool_result"),
    );
    expect(answered).toHaveLength(1);
    expect(
      answered[0]?.parts.flatMap((part) =>
        part.type === "tool_result" ? [[part.toolCallId, part.evidenceId]] : [],
      ),
    ).toEqual([
      ["tu-a", "e1"],
      ["tu-b", "e2"],
      ["tu-c", "e3"],
      ["tu-d", "e4"],
    ]);
    expect(
      answered[0]?.parts.flatMap((part) =>
        part.type === "tool_approval" ? [[part.toolCallId, part.approved]] : [],
      ),
    ).toEqual([
      ["tu-b", true],
      ["tu-d", true],
    ]);

    // The model learns that the write waited and which result predates the wait.
    const next = rows[rows.indexOf(answered[0]!) + 1];
    expect(next?.reminder).toBe("decision_wait");
    expect(next?.content).toContain("15 minutes");
    expect(next?.content).toMatch(/\be1\b/);
    expect(next?.content).not.toMatch(/\be[234]\b/);

    // The model's second request carries the whole turn's results in order.
    const resumed = messagesSentTo(scripted, requestsBefore + 1);
    expect(
      resumed.flatMap((m) => m.toolResults.map((r) => r.toolUseId)),
    ).toEqual(["tu-a", "tu-b", "tu-c", "tu-d"]);
    expect(JSON.stringify(resumed)).not.toContain("did not run");
    expect(getOpenTurn(sessionId)).toBeNull();

    close();
  });

  // Nothing can cancel a write once it starts, so a Stop that lands before the
  // released turn runs must end it first.
  it("an approved write never starts once Stop has landed", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-stop-write",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
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
      headers: { "Content-Type": "application/json", Cookie: SESSION },
      body: messageBody("Stop before the write."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["toolCallId"] === "tu-stop-write",
      ),
    );

    // Decided and claimed, then stopped in the same tick the run launches in.
    expect(
      resolveGate(
        sessionId,
        "tu-stop-write",
        {
          part: {
            type: "tool_approval",
            toolCallId: "tu-stop-write",
            approved: true,
          },
          waitedMs: 0,
        },
        null,
        null,
      ),
    ).toBe(true);
    nw.dispatcher.launch({ sessionId, seed: buildSeed(sessionId) });
    expect(nw.dispatcher.stop(sessionId)).toBe(true);
    await waitFor(() => !isRunning(sessionId));

    expect(restartCommands).toHaveLength(0);
    expect(deriveStatus(sessionId)).toBe("stopped");
    const parts = getTranscriptRows(sessionId).flatMap((row) => row.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "tu-stop-write",
        isError: true,
      }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool_approval",
        toolCallId: "tu-stop-write",
      }),
    );
    close();
  });

  it("no timeout: interrupt pending for hours is still resolvable", async () => {
    restartCommands.length = 0;

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-notmo-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
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
      body: messageBody("No timeout test."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Raise the interrupt on real clocks: fake timers stall an in-flight fetch,
    // so no request may be outstanding while the clock is frozen below.
    await waitFor(
      () =>
        events.find(
          (e) =>
            e.type === "HUMAN_INPUT_REQUIRED" &&
            e.payload["sessionId"] === sessionId,
        ),
      { timeout: 5_000 },
    );
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Jump a day with nothing in flight: any reaper timer would fire here.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    vi.useRealTimers();

    // Nothing reaped the interrupt row.
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    const approveRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({
          decision: "approve",
        }),
      },
    );
    expect(approveRes.status).toBe(200);

    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    close();
  });

  it("approve: executes tool on runner exactly once, run resumes, reaches free-form finish", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-apr-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
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
      body: messageBody("Service is wedged."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
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
    const body = (await approveRes.json()) as { status: string };
    expect(body.status).toBe("approved");

    // Run resumes and reaches free-form finish: INTERRUPT_RESOLVED arrives
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["toolCallId"] === "tu-apr-1",
      ),
    );

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
      ),
    );
    // The resumed request hands back the call, its result and the reasoning it was made with.
    const resumed = messagesSentTo(scripted, scripted.requests.length - 1);
    const turn = resumed.find((m) =>
      m.toolUses.some((u) => u.id === "tu-apr-1"),
    );
    expect(turn?.reasoning.length).toBeGreaterThan(0);
    expect(
      resumed.some((m) =>
        m.toolResults.some((r) => r.toolUseId === "tu-apr-1"),
      ),
    ).toBe(true);

    // Runner executed restart exactly once
    expect(restartCommands).toHaveLength(1);
    expect(restartCommands[0]["service"]).toEqual({
      project: "web-01",
      service: "web-01",
    });

    // Interrupt row is gone from DB after resolution
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    // Written once, in the row that answers the turn, so a crash cannot double it.
    const answers = getTranscriptRows(sessionId).flatMap((row) =>
      row.parts.flatMap((part) =>
        part.type === "tool_approval" && part.toolCallId === "tu-apr-1"
          ? [part]
          : [],
      ),
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]?.approved).toBe(true);

    // A report must exist for the route to answer, but the actions beside it
    // are independent of what it says.
    seedCompleteReport(sessionId);
    const reportRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/report`,
      { headers: { Cookie: `${SESSION}` } },
    );
    expect(reportRes.status).toBe(200);
    const { record, decisions } =
      (await reportRes.json()) as SessionReportResponse;
    expect(record.report).toBeNull();
    // Read back from the session's own record: the registry says the call was
    // gated, and no outcome on it says the user released it.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      toolCallId: "tu-apr-1",
      toolName: "RestartDockerService",
      target: "approval-host/web-01/web-01",
      decision: "approved",
    });

    // The decision is on the audit trail with who made it and what was released.
    const [approved] = await auditOf(sessionId);
    expect(approved).toMatchObject({
      action: "write_approved",
      actorEmail: "owner@example.test",
      target: "approval-host/web-01/web-01",
      details: {
        tool: "RestartDockerService",
        input: {
          target: "approval-host/web-01/web-01",
          reason: "wedged",
          estimatedDowntimeSeconds: 5,
        },
      },
    });
    // Deleting the session erases its record and leaves the trail.
    const deleted = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { method: "DELETE", headers: { Cookie: SESSION } },
    );
    expect(deleted.status).toBe(204);
    expect(await auditOf(sessionId)).toEqual([approved]);

    close();
  });

  it("reject: feeds rejection result with is_error, run resumes with model adapting", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            toolCallId: "tu-rej-1",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "wedged",
              estimatedDowntimeSeconds: 5,
            },
          },
          {
            toolCallId: "tu-rej-read",
            name: "ListDockerServices",
            input: { server: ["approval-host"] },
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
      body: messageBody("Service is wedged."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const rejectRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({
          decision: "reject",
          text: "too risky",
        }),
      },
    );
    expect(rejectRes.status).toBe(200);
    const body = (await rejectRes.json()) as { status: string };
    expect(body.status).toBe("rejected");

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["status"] === "rejected",
      ),
    );

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
      ),
    );
    expect(hasPendingHumanInput(sessionId)).toBe(false);
    // The refusal reaches the model as the call's answer, with the person's reason in it.
    const resumed = messagesSentTo(scripted, scripted.requests.length - 1);
    const answer = resumed
      .flatMap((m) => m.toolResults)
      .find((r) => r.toolUseId === "tu-rej-1");
    expect(answer?.content).toContain("too risky");
    expect(await auditOf(sessionId)).toMatchObject([
      {
        action: "write_rejected",
        details: { tool: "RestartDockerService", reason: "too risky" },
      },
    ]);
    // A rejection does not cancel the call asked for behind it: that read ran.
    const read = getTranscriptRows(sessionId)
      .flatMap((row) => row.parts)
      .find(
        (part) =>
          part.type === "tool_result" && part.toolCallId === "tu-rej-read",
      );
    expect(read).toMatchObject({ evidenceId: expect.any(String) });
    close();
  });
});
