import { RunPosition } from "../agent/loop/guardrails.js";
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "./gate-store.js";
import { getRecord } from "./record-store.js";
import { getTranscriptRows } from "./transcript-store.js";

// Reopening judges a finished write-up, so the run must have written it, spoken
// its closing turn, and be neither running nor waiting on a person.
export async function isReopenable(sessionId: string): Promise<boolean> {
  if (await dispatcher.isSessionRunning(sessionId)) return false;
  if (await hasPendingHumanInput(sessionId)) return false;
  const record = await getRecord(sessionId);
  if ((record?.report ?? null) === null) return false;
  const { reportWritten, closingTurnDone } = RunPosition.of(
    await getTranscriptRows(sessionId),
  );
  return reportWritten && closingTurnDone;
}
