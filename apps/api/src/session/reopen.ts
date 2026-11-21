import { RunPosition } from "../agent/loop/guardrails.js";
import { hasPendingHumanInput } from "./gate-store.js";
import { getRecord } from "./record-store.js";
import { isRunning } from "./status-store.js";
import { getTranscriptRows } from "./transcript-store.js";

// Reopening judges a finished write-up, so the run must have written it, spoken
// its closing turn, and be neither running nor waiting on a person.
export function isReopenable(sessionId: string): boolean {
  if (isRunning(sessionId)) return false;
  if (hasPendingHumanInput(sessionId)) return false;
  const record = getRecord(sessionId);
  if ((record?.report ?? null) === null) return false;
  const { reportWritten, closingTurnDone } = RunPosition.of(
    getTranscriptRows(sessionId),
  );
  return reportWritten && closingTurnDone;
}
