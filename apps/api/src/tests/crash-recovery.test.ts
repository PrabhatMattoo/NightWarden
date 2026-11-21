import { fakeModel } from "./fake-model.js";
import { randomUUID } from "node:crypto";
import { seedAlertSession } from "./session-helper.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedAlert, TranscriptRow } from "@nightwarden/shared";
import { dispatcherFor } from "../server.js";

// The reconciler's retries reach this provider.
const scripted = fakeModel();
const dispatcher = dispatcherFor(scripted.modelFor);

import { getDb } from "../db.js";
import { sessions } from "../session/schema.js";
import {
  claimRun,
  deriveStatus,
  isRunning,
  runFailure,
} from "../session/status-store.js";
import {
  appendRowsAndPark,
  appendTranscriptRows,
  getTranscriptRows,
} from "../session/transcript-store.js";
import { recoverDeadRuns } from "../session/recover.js";
import { buildSeed } from "../session/seed.js";
import { reconcileRecovery } from "../verification/reconciler.js";
import { updateConfig } from "../config/store.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";

const alert: NormalizedAlert = {
  sourceAlertId: "src-crash",
  labels: {},
  alertType: "ContainerDown",
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
    {
      sessionId,
      toolCallId: "tu-gated",
      kind: "approval",
      completedResults: [],
      claimedAt: null,
    },
  );
}

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

  it("tells the person to check the target when an approved write ran and its result was lost", () => {
    const sessionId = alertSession();
    parkOnApproval(sessionId);
    // Approval clears the gate before the resume claims the run; this is that gap.
    getDb()
      .update(sessions)
      .set({ awaitingToolUseId: null, awaitingKind: null })
      .where(eq(sessions.sessionId, sessionId))
      .run();

    recoverDeadRuns();

    expect(deriveStatus(sessionId)).toBe("failed");
    const note = getTranscriptRows(sessionId).find((m) => m.kind === "error");
    expect(note?.content).toContain(
      "check the target before approving it again",
    );
  });

  // A gated call is unanswered until a human decides, so unwinding past it hands
  // the model results for a call it can no longer see it made.
  it("keeps a gated turn once its answer is on the record", () => {
    const sessionId = alertSession();
    const at = new Date().toISOString();
    appendTranscriptRows([
      {
        sessionId,
        seq: 0,
        kind: "user",
        content: "restart it",
        parts: [{ type: "text", text: "restart it" }],
        timestamp: at,
      },
      {
        sessionId,
        seq: 1,
        kind: "assistant",
        content: "[tool: RestartDockerService]",
        parts: [
          {
            type: "tool_call",
            toolCallId: "tu-read",
            name: "ListDockerServices",
            input: {},
          },
          {
            type: "tool_call",
            toolCallId: "tu-gate",
            name: "RestartDockerService",
            input: { target: "prod-1/web/api" },
          },
        ],
        timestamp: at,
      },
    ]);

    // Nobody has answered, so the turn is dropped: no conversation may end on it.
    expect(buildSeed(sessionId)).toHaveLength(1);

    // Resolving a gate writes the whole turn's results before it clears, so the
    // seed finds the exchange answered on the transcript.
    appendTranscriptRows([
      {
        sessionId,
        seq: 2,
        kind: "user",
        content: "results",
        parts: [
          { type: "tool_result", toolCallId: "tu-read", output: "ok" },
          { type: "tool_result", toolCallId: "tu-gate", output: "restarted" },
        ],
        timestamp: at,
      },
    ]);

    const resumed = buildSeed(sessionId);
    expect(resumed).toHaveLength(3);
    expect(resumed[1]?.parts.map((p) => p.type)).toEqual([
      "tool_call",
      "tool_call",
    ]);
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
