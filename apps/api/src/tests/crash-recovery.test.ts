import { fakeModel } from "./fake-model.js";
import { randomUUID } from "node:crypto";
import { seedAlertSession, UNANSWERED_TURN } from "./session-helper.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedAlert, TranscriptRow } from "@nightwarden/shared";
import { dispatcherFor } from "../server.js";

// The reconciler's retries reach this provider.
const scripted = fakeModel();
const dispatcher = dispatcherFor(scripted.modelFor);

import { createRunner } from "../fleet/runners-store.js";
import { getOpenTurn, resolveGate } from "../session/gate-store.js";
import type { Decision } from "../session/schema.js";
import {
  claimRun,
  deriveStatus,
  isRunning,
  runFailure,
} from "../session/status-store.js";
import {
  appendRowsAndCloseTurn,
  appendRowsAndPark,
  appendTranscriptRows,
  getTranscriptRows,
} from "../session/transcript-store.js";
import { recoverDeadRuns } from "../session/recover.js";
import { buildSeed } from "../session/seed.js";
import { reconcileRecovery } from "../verification/reconciler.js";
import { updateConfig } from "../config/store.js";
import { fakeRunner } from "./harness.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";

const alert: NormalizedAlert = {
  sourceAlertId: "src-crash",
  labels: {},
  alertName: "ContainerDown",
  firedAt: "2026-06-13T00:00:00.000Z",
  annotations: {},
  generatorURL: null,
  values: {},
};

function alertSession(): string {
  const sessionId = randomUUID();
  seedAlertSession(
    { sessionId, title: "t", createdAt: new Date().toISOString() },
    [{ ...alert, sourceAlertId: sessionId }],
  );
  return sessionId;
}

function callTurn(
  sessionId: string,
  seq: number,
  toolCallId: string,
  name: string,
): TranscriptRow {
  return {
    sessionId,
    seq,
    kind: "assistant",
    content: `[tool: ${name}]`,
    parts: [{ type: "tool_call", toolCallId, name, input: {} }],
    timestamp: new Date().toISOString(),
  };
}

function parkOnApproval(sessionId: string): void {
  appendRowsAndPark(
    [callTurn(sessionId, 0, "tu-gated", "RestartDockerService")],
    { sessionId, toolCallId: "tu-gated", kind: "approval" },
    UNANSWERED_TURN,
  );
}

// The assistant's reply: a read, a write that needs approval, then another read.
function readWriteReadTurn(sessionId: string, seq: number): TranscriptRow {
  const call = (toolCallId: string, name: string) =>
    ({ type: "tool_call", toolCallId, name, input: {} }) as const;
  return {
    sessionId,
    seq,
    kind: "assistant",
    content: "[tools]",
    parts: [
      call("tu-a", "ListDockerServices"),
      call("tu-b", "RestartDockerService"),
      call("tu-c", "ListDockerServices"),
    ],
    timestamp: new Date().toISOString(),
  };
}

const APPROVED_B: Decision = {
  part: { type: "tool_approval", toolCallId: "tu-b", approved: true },
  waitedMs: 0,
};

describe("recovering runs a restart interrupted", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
  });

  it("fails a run killed mid-turn as transient, answers its call as interrupted, and the reconciler retries it", async () => {
    scripted.script([{ text: "Done.", toolUses: [] }]);
    const sessionId = alertSession();
    appendTranscriptRows([callTurn(sessionId, 0, "tu-edit", "Edit")]);
    claimRun(sessionId);

    expect(recoverDeadRuns()).toBe(1);

    expect(deriveStatus(sessionId)).toBe("failed");
    expect(runFailure(sessionId)).toEqual({
      kind: "transient",
      attempts: 1,
    });
    const answer = getTranscriptRows(sessionId)
      .flatMap((row) => row.parts)
      .find((p) => p.type === "tool_result" && p.toolCallId === "tu-edit");
    expect(answer).toMatchObject({ isError: true });
    expect(answer).not.toHaveProperty("evidenceId");
    expect(answer?.type === "tool_result" && answer.output).toContain(
      "result unknown",
    );

    const pass = await reconcileRecovery(dispatcher);
    expect(pass.retried).toBe(1);
    await waitFor(() => !isRunning(sessionId));
  });

  it("stops retrying a run once it has failed as often as Settings allows", async () => {
    updateConfig({ maxRetries: 1 });
    const sessionId = alertSession();
    claimRun(sessionId);
    recoverDeadRuns();

    const pass = await reconcileRecovery(dispatcher);
    updateConfig({ maxRetries: 3 });

    expect(runFailure(sessionId)).toMatchObject({ attempts: 1 });
    expect(pass.retried).toBe(0);
  });

  it("leaves a session waiting on a human alone: it suspended, it did not die", () => {
    const sessionId = alertSession();
    parkOnApproval(sessionId);

    recoverDeadRuns();

    expect(deriveStatus(sessionId)).toBe("action_required");
    expect(getTranscriptRows(sessionId).some((m) => m.kind === "error")).toBe(
      false,
    );
  });

  /* The decision claimed the run before the process died, so the boot finds a
     running session holding a turn half answered. The approved write may have run,
     so it is answered as unknown rather than run again. */
  it("answers a released turn's unfinished calls as unknown and keeps the ids it numbered", async () => {
    const sessionId = alertSession();
    appendRowsAndPark(
      [readWriteReadTurn(sessionId, 0)],
      { sessionId, toolCallId: "tu-b", kind: "approval" },
      {
        stage: "gathering",
        results: [{ toolCallId: "tu-a", content: "read before the wait" }],
        decisions: [],
      },
    );
    expect(resolveGate(sessionId, "tu-b", APPROVED_B, null, null)).toBe(true);

    recoverDeadRuns();

    // One row answers the turn: the stored read keeps its handle, the rest say
    // their result is unknown, and the approval sits beside them.
    const answered = getTranscriptRows(sessionId).filter((row) =>
      row.parts.some((part) => part.type === "tool_result"),
    );
    expect(answered).toHaveLength(1);
    const parts = answered[0]?.parts ?? [];
    expect(
      parts.flatMap((part) =>
        part.type === "tool_result"
          ? [[part.toolCallId, part.evidenceId, part.isError]]
          : [],
      ),
    ).toEqual([
      ["tu-a", "e1", undefined],
      ["tu-b", undefined, true],
      ["tu-c", undefined, true],
    ]);
    expect(
      parts.flatMap((part) =>
        part.type === "tool_result" ? [part.output] : [],
      ),
    ).toEqual([
      "read before the wait",
      expect.stringContaining("result unknown"),
      expect.stringContaining("result unknown"),
    ]);
    expect(parts).toContainEqual(APPROVED_B.part);
    expect(getOpenTurn(sessionId)).toBeNull();

    // The retry starts over from an empty seed, and still numbers past e1.
    const runner = fakeRunner({
      id: createRunner("docker", "crash-host").id,
      name: "crash-host",
    });
    scripted.script([
      {
        text: "Reading.",
        toolUses: [
          {
            toolCallId: "tu-retry",
            name: "ListDockerServices",
            input: { server: ["crash-host"] },
          },
        ],
      },
      { text: "Done.", toolUses: [] },
    ]);
    const pass = await reconcileRecovery(dispatcher);
    expect(pass.retried).toBe(1);
    await waitFor(() => !isRunning(sessionId));
    runner.disconnect();
    expect(
      getTranscriptRows(sessionId)
        .flatMap((row) => row.parts)
        .find(
          (part) =>
            part.type === "tool_result" && part.toolCallId === "tu-retry",
        ),
    ).toMatchObject({ evidenceId: "e2" });
  });

  /* A gated call is unanswered until a person decides, so unwinding past it hands
     the model results for a call it can no longer see it made. */
  it("seeds a gated turn only once a decision released it, and in full once it is answered", () => {
    const sessionId = alertSession();
    const at = new Date().toISOString();
    appendRowsAndPark(
      [
        {
          sessionId,
          seq: 0,
          kind: "user",
          content: "restart it",
          parts: [{ type: "text", text: "restart it" }],
          timestamp: at,
        },
        readWriteReadTurn(sessionId, 1),
      ],
      { sessionId, toolCallId: "tu-b", kind: "approval" },
      {
        stage: "conversation",
        results: [{ toolCallId: "tu-a", content: "ok" }],
        decisions: [],
      },
    );

    // Nobody has decided, so the turn is dropped: no conversation may end on it.
    expect(buildSeed(sessionId)).toHaveLength(1);

    // The decision released it, so its run finishes the calls and answers before
    // asking, and the turn stays in the conversation it will send.
    expect(resolveGate(sessionId, "tu-b", APPROVED_B, null, null)).toBe(true);
    expect(buildSeed(sessionId)).toHaveLength(2);

    // Answered in full, the exchange is an ordinary one.
    appendRowsAndCloseTurn([
      {
        sessionId,
        seq: 2,
        kind: "user",
        content: "results",
        parts: [
          { type: "tool_result", toolCallId: "tu-a", output: "ok" },
          { type: "tool_result", toolCallId: "tu-b", output: "restarted" },
          { type: "tool_result", toolCallId: "tu-c", output: "ok" },
        ],
        timestamp: at,
      },
    ]);
    expect(buildSeed(sessionId)).toHaveLength(3);
  });

  // Only a trailing exchange is cut, so later turns survive an earlier unanswered call.
  it("never erases the turns after an unanswered call", () => {
    const sessionId = alertSession();
    const at = new Date().toISOString();
    appendTranscriptRows([
      {
        sessionId,
        seq: 0,
        kind: "assistant",
        content: "[tool: ListDockerServices]",
        parts: [
          {
            type: "tool_call",
            toolCallId: "tu-lost",
            name: "ListDockerServices",
            input: {},
          },
        ],
        timestamp: at,
      },
      {
        sessionId,
        seq: 1,
        kind: "user",
        content: "carry on",
        parts: [{ type: "text", text: "carry on" }],
        timestamp: at,
      },
      {
        sessionId,
        seq: 2,
        kind: "assistant",
        content: "Carrying on.",
        parts: [{ type: "text", text: "Carrying on." }],
        timestamp: at,
      },
    ]);

    expect(buildSeed(sessionId)).toHaveLength(3);
  });
});
