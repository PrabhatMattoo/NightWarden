import { randomUUID } from "node:crypto";
import { messageBody } from "./session-helper.js";
import { harness, type Harness } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fakeModel, messagesSentTo, type ScriptedTurn } from "./fake-model.js";

const scripted = fakeModel();
const setScript = (turns: ScriptedTurn[]): void => scripted.script(turns);

import { waitFor } from "./wait.js";
import { connectFrontendEvents } from "./frontend-events-helper.js";

import { isRunning } from "../session/status-store.js";
import { hasPendingHumanInput } from "../session/gate-store.js";
import { buildTranscript } from "../session/transcript.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Answered. Investigation complete.",
  toolUses: [],
};

const TEST_OPTIONS = [
  {
    label: "Database overloaded",
    description: "High query volume saturated connection pool",
  },
  { label: "Memory leak", description: "Gradual memory growth causing OOM" },
];

describe("clarification interrupts", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    nw = await harness({
      model: scripted,
      runners: [
        {
          name: "clar-host",
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

  it("AskUserQuestion suspends: interrupt row kind=clarification, INTERRUPT event has kind+question+options, run exited", async () => {
    setScript([
      {
        text: "Need clarification.",
        toolUses: [
          {
            toolCallId: "tu-clar-1",
            name: "AskUserQuestion",
            input: {
              question: "What is the likely root cause?",
              options: TEST_OPTIONS,
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
      body: messageBody("Service degraded."),
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

    // Run must have exited
    expect(isRunning(sessionId)).toBe(false);

    // DB row must have kind=clarification
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // INTERRUPT event carries kind + question + options
    expect(interrupt.payload["kind"]).toBe("clarification");
    expect(interrupt.payload["question"]).toBe(
      "What is the likely root cause?",
    );
    expect(interrupt.payload["options"]).toEqual(TEST_OPTIONS);
    expect(interrupt.payload["toolName"]).toBe("AskUserQuestion");

    close();

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ text: "cleanup" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  });

  it("multiSelect answer: joins selections as comma-separated string in tool result", async () => {
    setScript([
      {
        text: "Which factors apply?",
        toolUses: [
          {
            toolCallId: "tu-ms-1",
            name: "AskUserQuestion",
            input: {
              question: "Which factors apply?",
              options: TEST_OPTIONS,
              multiSelect: true,
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
      body: messageBody("Factors?"),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    expect(interrupt.payload["multiSelect"]).toBe(true);

    // Frontend pre-joins selections; server receives a plain string
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({
          text: "Database overloaded, Memory leak",
        }),
      },
    );
    expect(answerRes.status).toBe(200);

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["toolCallId"] === "tu-ms-1",
      ),
    );
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    close();
  });

  // Providers honour maxItems unevenly, so the harness holds the line. Refused
  // whole, since dropping the rest hides a choice the person may have needed.
  it("refuses a question offering more options than a card can show, and is re-asked", async () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: `What picking option ${i + 1} would mean`,
    }));
    setScript([
      {
        text: "Too many choices.",
        toolUses: [
          {
            toolCallId: "tu-over-1",
            name: "AskUserQuestion",
            input: { question: "Which one?", options: tooMany },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody("Which one?"),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // It never reaches a person: the run carries on to its next turn instead.
    await waitFor(() => !isRunning(sessionId));
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    const asked = buildTranscript(sessionId).find(
      (item) => item.kind === "tool_call" && item.toolCallId === "tu-over-1",
    );
    expect(asked?.kind === "tool_call" && asked.state).toMatchObject({
      phase: "complete",
    });
    // The message names the cap and says the free-text box covers the rest, so
    // the model can drop an option rather than guess at why it was refused.
    const state = asked?.kind === "tool_call" ? asked.state : null;
    const said = state?.phase === "complete" ? String(state.result) : "";
    expect(said).toMatch(/at most 4/);
  });

  it("clarification with decision body returns 400", async () => {
    setScript([
      {
        text: "Need clarification.",
        toolUses: [
          {
            toolCallId: "tu-clar-val-1",
            name: "AskUserQuestion",
            input: { question: "Confirm?", options: TEST_OPTIONS },
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
      body: messageBody("Test."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Sending decision:"approve" on a clarification interrupt must return 400
    const badRes = await fetch(
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
    expect(badRes.status).toBe(400);

    close();

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ text: "cleanup" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  });

  it("restart-resume: clarification interrupt survives process exit, resolve still works", async () => {
    setScript([
      {
        text: "Clarifying.",
        toolUses: [
          {
            toolCallId: "tu-rr-clar-1",
            name: "AskUserQuestion",
            input: { question: "Is this recurring?", options: TEST_OPTIONS },
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
      body: messageBody("Is this recurring?"),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Simulate process exit: run has exited, no in-memory state needed
    expect(isRunning(sessionId)).toBe(false);
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Resolve purely from DB state
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({
          text: "Yes, recurring daily",
        }),
      },
    );
    expect(answerRes.status).toBe(200);

    await waitFor(() => !hasPendingHumanInput(sessionId));
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    close();
  });

  it("a question and a write in one turn: the answer carries the turn to the write's own card, with no new model call", async () => {
    restartCommands.length = 0;
    const clarId = `tu-mix-clar-${randomUUID()}`;
    const restartId = `tu-mix-restart-${randomUUID()}`;
    const requestsBefore = scripted.requests.length;

    setScript([
      {
        text: "Ask then restart.",
        toolUses: [
          {
            toolCallId: clarId,
            name: "AskUserQuestion",
            input: {
              question: "Confirm restart?",
              options: [{ label: "Yes", description: "Proceed" }],
            },
          },
          {
            toolCallId: restartId,
            name: "RestartDockerService",
            input: {
              target: "clar-host/web-01/web-01",
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
      body: messageBody("Mixed gate test."),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // First interrupt: clarification
    const clarInterrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "clarification",
      ),
    );
    expect(clarInterrupt.payload["kind"]).toBe("clarification");
    expect(restartCommands).toHaveLength(0);

    const answerRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ text: "Yes" }),
      },
    );
    expect(answerRes.status).toBe(200);

    // The write the same turn asked for next, held for approval without the
    // model being asked again.
    const approvalInterrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "approval",
      ),
    );
    expect(approvalInterrupt.payload["toolCallId"]).toBe(restartId);
    expect(restartCommands).toHaveLength(0);
    expect(scripted.requests.length - requestsBefore).toBe(1);

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

    // Restart executes exactly once, run completes
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    close();
  });

  it("answer resolves: resumes run, tool result contains answer, reaches free-form finish", async () => {
    setScript([
      {
        text: "Need clarification.",
        toolUses: [
          {
            toolCallId: "tu-ans-1",
            name: "AskUserQuestion",
            input: {
              question: "Which container is affected?",
              options: TEST_OPTIONS,
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
      body: messageBody("Which container?"),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({
          text: "Database overloaded",
        }),
      },
    );
    expect(answerRes.status).toBe(200);
    const body = (await answerRes.json()) as { status: string };
    expect(body.status).toBe("answered");

    // INTERRUPT_RESOLVED arrives, run resumes, reaches free-form finish
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["toolCallId"] === "tu-ans-1",
      ),
    );

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
      ),
    );
    // The answer reaches the model as the question's result.
    const resumed = messagesSentTo(scripted, scripted.requests.length - 1);
    expect(
      resumed
        .flatMap((m) => m.toolResults)
        .find((r) => r.toolUseId === "tu-ans-1")?.content,
    ).toContain("Database overloaded");

    // Interrupt row gone after resolution
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    // One ordinary call carrying what the person said, rather than a question
    // card that outlives its own answer.
    const asked = buildTranscript(sessionId).filter(
      (item) => item.kind === "tool_call" && item.toolCallId === "tu-ans-1",
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.kind === "tool_call" && asked[0].state).toMatchObject({
      phase: "resolved",
      decision: "answered",
      result: "Database overloaded",
    });

    close();
  });
});
