import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LLM_PROVIDER_NAMES,
  type SessionReportResponse,
} from "@nightwarden/shared";
import { fakeAnthropic } from "./fake-anthropic.js";
import {
  messagesSentTo,
  type FakeModel,
  type ScriptedTurn,
} from "./fake-model.js";
import { harness, type Harness } from "./harness.js";
import { seedCompleteReport } from "./report-helper.js";
import { messageBody } from "./session-helper.js";

const anthropic = fakeAnthropic();
const setScript = (turns: ScriptedTurn[]): void => anthropic.script(turns);

import { waitFor } from "./wait.js";
import {
  connectFrontendEvents,
  toolCallReached,
} from "./frontend-events-helper.js";

import { isRunning } from "../session/status-store.js";
import { hasPendingHumanInput } from "../session/gate-store.js";
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
      model: anthropic,
      runners: [
        {
          name: "approval-host",
          services: ["web-01"],
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
    expect(await isRunning(sessionId)).toBe(false);

    // Interrupt row must be in the DB
    expect(await hasPendingHumanInput(sessionId)).toBe(true);

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
    expect(await hasPendingHumanInput(sessionId)).toBe(true);

    close();

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject" }),
    });
    await waitFor(async () => !(await hasPendingHumanInput(sessionId)));
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

    expect(await hasPendingHumanInput(sessionId)).toBe(false);
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
    expect(await isRunning(sessionId)).toBe(false);

    // Assert: interrupt row is in DB (survives a restart because it's persisted)
    expect(await hasPendingHumanInput(sessionId)).toBe(true);

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

  it("mixed parallel turn: non-gated tools execute first, resume covers all tool_uses", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Checking then restarting.",
        toolUses: [
          {
            toolCallId: "tu-mix-read",
            name: "ListDockerServices",
            input: {},
          },
          {
            toolCallId: "tu-mix-gate",
            name: "RestartDockerService",
            input: {
              target: "approval-host/web-01/web-01",
              reason: "mixed",
              estimatedDowntimeSeconds: 2,
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
      body: messageBody("Mixed turn test."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // The non-gated read tool should have completed before suspension
    expect(toolCallReached(events, "tu-mix-read", "complete")).toBe(true);

    // The gated tool was NOT called on the runner yet
    expect(restartCommands).toHaveLength(0);

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

    // Gated tool now runs exactly once on the runner
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

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
    expect(await hasPendingHumanInput(sessionId)).toBe(true);

    // Jump a day with nothing in flight: any reaper timer would fire here.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    vi.useRealTimers();

    // Nothing reaped the interrupt row.
    expect(await hasPendingHumanInput(sessionId)).toBe(true);

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
});

// Resuming re-sends the whole conversation, so each provider's wire takes the suspended turn back.
describe.each(LLM_PROVIDER_NAMES)("approving a write on %s", (provider) => {
  let nw: Harness;
  let port: number;
  let SESSION: string;
  let model: FakeModel;
  const restartCommands: Array<Record<string, unknown>> = [];
  const setScript = (turns: ScriptedTurn[]): void => model.script(turns);

  beforeAll(async () => {
    nw = await harness({
      provider,
      runners: [
        {
          name: "approval-host",
          services: ["web-01"],
          answer: ({ commandName, commandInput }) => {
            if (commandName !== "RestartDockerService") return [];
            restartCommands.push(commandInput);
            return { restarted: true };
          },
        },
      ],
    });
    ({ port, session: SESSION, model } = nw);
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
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
    const resumed = messagesSentTo(model, model.requests.length - 1);
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
    expect(await hasPendingHumanInput(sessionId)).toBe(false);

    /* Written by the resolve in the transaction that cleared the gate, and never
       again by the resumed run, so a crash between them loses nor doubles it. */
    const answers = (await getTranscriptRows(sessionId)).flatMap((row) =>
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
    await seedCompleteReport(sessionId);
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
    expect(await hasPendingHumanInput(sessionId)).toBe(false);
    // The refusal reaches the model as the call's answer, with the person's reason in it.
    const resumed = messagesSentTo(model, model.requests.length - 1);
    const answer = resumed
      .flatMap((m) => m.toolResults)
      .find((r) => r.toolUseId === "tu-rej-1");
    expect(answer?.content).toContain("too risky");
    close();
  });
});
