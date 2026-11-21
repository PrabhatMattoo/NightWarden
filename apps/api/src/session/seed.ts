import type { TranscriptRow } from "@nightwarden/shared";
import { getTranscriptRows } from "./transcript-store.js";
import type { ProviderMessage } from "../llm/types.js";

function hasToolCall(message: TranscriptRow): boolean {
  return message.parts.some((p) => p.type === "tool_call");
}

/* Providers refuse a conversation ending on an unanswered call, so only that tail goes;
   stops, resolved gates and restarts answer theirs. */
function throughLastAnsweredExchange(rows: TranscriptRow[]): TranscriptRow[] {
  const answered = new Set<string>();
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type === "tool_result") answered.add(part.toolCallId);
    }
  }
  const last = rows.map((row) => row.kind).lastIndexOf("assistant");
  const unanswered = rows[last]?.parts.some(
    (part) => part.type === "tool_call" && !answered.has(part.toolCallId),
  );
  return unanswered === true ? rows.slice(0, last) : rows;
}

// Maps our four kinds onto the provider's two roles.
export function toProviderMessage(row: TranscriptRow): ProviderMessage {
  return {
    role: row.kind === "assistant" ? "assistant" : "user",
    content: row.content,
    parts: row.parts,
  };
}

// An error row and the dead exchange it terminates drop back to the last clean
// assistant turn, so the stage derives from what the model is actually handed.
export function seedRows(sessionId: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const message of getTranscriptRows(sessionId)) {
    if (message.kind !== "error") {
      rows.push(message);
      continue;
    }
    /* Never replayed: whatever killed that exchange - a context window it no
       longer fits in, a request the provider refused - would kill it again. */
    while (rows.length > 0) {
      const last = rows[rows.length - 1];
      if (last?.kind === "assistant" && !hasToolCall(last)) break;
      rows.pop();
    }
  }
  return throughLastAnsweredExchange(rows);
}

export function buildSeed(sessionId: string): ProviderMessage[] {
  return seedRows(sessionId).map(toProviderMessage);
}
