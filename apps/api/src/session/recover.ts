import type { TranscriptRow } from "@nightwarden/shared";
import { hasPendingHumanInput } from "./gate-store.js";
import {
  abandonedSessionIds,
  markDone,
  recordRunFailure,
  runningSessionIds,
} from "./status-store.js";
import {
  appendErrorMessage,
  appendTranscriptRows,
  getNextSeq,
  getTranscriptRows,
} from "./transcript-store.js";
import { logger } from "../logger.js";

const RESTARTED = "NightWarden restarted while this was running.";

const INTERRUPTED_CALL =
  "Interrupted, result unknown: NightWarden restarted before this call returned.";

const ABANDONED =
  "This investigation was interrupted: NightWarden stopped just after the approved call ran, so its result was lost. Whether the call took effect is unknown - check the target before approving it again.";

// What a crash between writing the assistant turn and running its tools leaves.
function unansweredCallIds(rows: TranscriptRow[]): string[] {
  const answered = new Set<string>();
  const calls: string[] = [];
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type === "tool_call") calls.push(part.toolCallId);
      else if (part.type === "tool_result") answered.add(part.toolCallId);
    }
  }
  return calls.filter((id) => !answered.has(id));
}

// Answered without running anything: no runner has reconnected yet, and a write
// may already have taken effect.
function failRestartedRun(sessionId: string): void {
  const ids = unansweredCallIds(getTranscriptRows(sessionId));
  if (ids.length > 0) {
    appendTranscriptRows([
      {
        sessionId,
        seq: getNextSeq(sessionId),
        kind: "user",
        content: INTERRUPTED_CALL,
        parts: ids.map((toolCallId) => ({
          type: "tool_result",
          toolCallId,
          output: INTERRUPTED_CALL,
          isError: true,
        })),
        timestamp: new Date().toISOString(),
      },
    ]);
  }
  recordRunFailure(sessionId, "transient");
  appendErrorMessage(sessionId, RESTARTED);
}

// 'action_required' with no gate row died between approving a call and claiming
// the resume: the write already ran and its result is gone.
function abandonedRuns(): string[] {
  const abandoned: string[] = [];
  for (const sessionId of abandonedSessionIds()) {
    if (!hasPendingHumanInput(sessionId)) abandoned.push(sessionId);
  }
  return abandoned;
}

/* A run still flagged running died with the process, so it fails as transient and
   the reconciler retries it once runners are back. Dispatches nothing itself. */
export function recoverDeadRuns(): number {
  const killed = runningSessionIds();
  const abandoned = abandonedRuns();
  for (const sessionId of [...killed, ...abandoned]) {
    // markDone rather than releaseRun: an abandoned suspension is not running,
    // which is exactly why releaseRun would decline to touch it.
    markDone(sessionId);
    try {
      if (killed.includes(sessionId)) failRestartedRun(sessionId);
      else appendErrorMessage(sessionId, ABANDONED);
    } catch (err) {
      // One session's recovery must never stop the boot.
      logger.warn({ err, sessionId }, "could not record a run a restart ended");
    }
  }
  return killed.length + abandoned.length;
}
