import { messagePartsToText } from "@nightwarden/shared";
import type { MessagePart, ToolCallPart } from "@nightwarden/shared";
import { highestEvidenceNumber, resultParts } from "../agent/evidence-id.js";
import { citableIds } from "../agent/loop/guardrails.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { getOpenTurn } from "./gate-store.js";
import {
  markDone,
  recordRunFailure,
  runningSessionIds,
} from "./status-store.js";
import {
  appendErrorMessage,
  appendRowsAndCloseTurn,
  getNextSeq,
  getTranscriptRows,
} from "./transcript-store.js";

const RESTARTED = "NightWarden restarted while this was running.";

const INTERRUPTED_CALL =
  "Interrupted, result unknown: NightWarden restarted before this call returned.";

/* Closes the turn a dead run left open, with no call run again: a write may
   already have taken effect. Every other turn answered its calls as it ended. */
export function answerUnfinishedCalls(sessionId: string, text: string): void {
  const rows = getTranscriptRows(sessionId);
  const open = getOpenTurn(sessionId);
  const lastTurn = rows[rows.map((row) => row.kind).lastIndexOf("assistant")];
  const calls = (lastTurn?.parts ?? []).filter(
    (part): part is ToolCallPart => part.type === "tool_call",
  );
  const answered = new Set([
    ...rows.flatMap((row) =>
      row.parts.flatMap((part) =>
        part.type === "tool_result" ? [part.toolCallId] : [],
      ),
    ),
    ...(open?.results ?? []).map((result) => result.toolCallId),
  ]);
  const unanswered: ToolResult[] = calls
    .filter((call) => !answered.has(call.toolCallId))
    .map((call) => ({
      toolCallId: call.toolCallId,
      content: text,
      isError: true,
    }));
  const results = [...(open?.results ?? []), ...unanswered];
  if (results.length === 0) return;
  const stamped = resultParts(
    results,
    citableIds(calls),
    highestEvidenceNumber(rows) + 1,
  );
  const parts: MessagePart[] = [
    ...stamped.parts,
    ...(open?.decisions ?? []).map((decision) => decision.part),
  ];
  appendRowsAndCloseTurn([
    {
      sessionId,
      seq: getNextSeq(sessionId),
      kind: "user",
      content: messagePartsToText(parts),
      parts,
      timestamp: new Date().toISOString(),
    },
  ]);
}

/* A run still flagged running died with the process, so it fails as transient and
   the reconciler retries it once runners are back. Dispatches nothing itself. */
export function recoverDeadRuns(): number {
  const killed = runningSessionIds();
  for (const sessionId of killed) {
    markDone(sessionId);
    try {
      answerUnfinishedCalls(sessionId, INTERRUPTED_CALL);
      recordRunFailure(sessionId, "transient");
      appendErrorMessage(sessionId, RESTARTED);
    } catch (err) {
      // One session's recovery must never stop the boot.
      logger.warn({ err, sessionId }, "could not record a run a restart ended");
    }
  }
  return killed.length;
}
