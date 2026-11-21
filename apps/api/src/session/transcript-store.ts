import { and, asc, eq, isNotNull, max } from "drizzle-orm";
import type { TranscriptRow } from "@nightwarden/shared";
import { getDb, type Db } from "../db.js";
import type { PendingHumanInput } from "./gate-store.js";
import { sessions, sessionTranscript } from "./schema.js";
import { refreshSessionStatus } from "./status-store.js";

// Transcript rows, appended a turn at a time.

// Written inside each appender's transaction, so the stamp the queue sorts on
// cannot fall behind the transcript it summarises.
function touchSession(sessionId: string, at: string, db: Db): void {
  db.update(sessions)
    .set({ lastActivityAt: at })
    .where(eq(sessions.sessionId, sessionId))
    .run();
}

function rowValues(m: TranscriptRow) {
  return {
    sessionId: m.sessionId,
    seq: m.seq,
    kind: m.kind,
    content: m.content,
    canonical: m.parts.length === 0 ? null : { parts: m.parts },
    timestamp: m.timestamp,
    clientId: m.clientId ?? null,
    reminder: m.reminder ?? null,
  };
}

// The (session_id, seq) primary key forbids a duplicate seq and the transaction
// makes the turn all-or-nothing, so the checkpoint never holds a hole.
export function appendTranscriptRows(messages: TranscriptRow[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  getDb().transaction((tx) => {
    tx.insert(sessionTranscript).values(messages.map(rowValues)).run();
    touchSession(last.sessionId, last.timestamp, tx);
    // The tail decides whether a session reads as failed, so appending to
    // it can change the answer. A no-op while a run holds 'running'.
    refreshSessionStatus(last.sessionId, tx);
  });
}

export function getNextSeq(sessionId: string, db: Db = getDb()): number {
  const row = db
    .select({ highest: max(sessionTranscript.seq) })
    .from(sessionTranscript)
    .where(eq(sessionTranscript.sessionId, sessionId))
    .get();
  return (row?.highest ?? -1) + 1;
}

// NightWarden's own failure note, appended after the turn that died. Display
// and history only; buildSeed keeps it away from the model.
export function appendErrorMessage(
  sessionId: string,
  text: string,
): TranscriptRow {
  const message: TranscriptRow = {
    sessionId,
    seq: 0,
    kind: "error",
    content: text,
    parts: [],
    timestamp: new Date().toISOString(),
  };
  getDb().transaction((tx) => {
    message.seq = getNextSeq(sessionId, tx);
    tx.insert(sessionTranscript).values(rowValues(message)).run();
    touchSession(sessionId, message.timestamp, tx);
    // An error row is what makes a session read as failed. A no-op while the
    // run still holds 'running', where releaseRun derives the same later.
    refreshSessionStatus(sessionId, tx);
  });
  return message;
}

// Called when suspending on a gated tool, so the database is always consistent:
// both the messages and the gate exist, or neither does.
export function appendRowsAndPark(
  messages: TranscriptRow[],
  pendingHumanInput: PendingHumanInput,
): void {
  getDb().transaction((tx) => {
    if (messages.length > 0) {
      tx.insert(sessionTranscript).values(messages.map(rowValues)).run();
    }
    // Suspending is the gate, so the status saying this session waits is
    // written with it: the two are columns on the same row.
    tx.update(sessions)
      .set({
        status: "action_required",
        awaitingToolUseId: pendingHumanInput.toolCallId,
        awaitingKind: pendingHumanInput.kind,
        awaitingResults: pendingHumanInput.completedResults,
        attemptStartedAt: pendingHumanInput.claimedAt ?? null,
      })
      .where(eq(sessions.sessionId, pendingHumanInput.sessionId))
      .run();
    const last = messages[messages.length - 1];
    if (last) touchSession(last.sessionId, last.timestamp, tx);
  });
}

/* The answered turn and the cleared gate in one transaction, so a crash between
   them cannot lose the result of a command that already ran. */
export function appendRowsAndResolve(
  sessionId: string,
  messages: TranscriptRow[],
): boolean {
  return getDb().transaction((tx) => {
    // Cleared first, so a loser writes nothing rather than a duplicate turn.
    const cleared = tx
      .update(sessions)
      .set({
        awaitingToolUseId: null,
        awaitingKind: null,
        awaitingResults: [],
        attemptStartedAt: null,
      })
      .where(
        and(
          eq(sessions.sessionId, sessionId),
          isNotNull(sessions.awaitingToolUseId),
        ),
      )
      .run();
    if (cleared.changes === 0) return false;
    if (messages.length > 0) {
      tx.insert(sessionTranscript).values(messages.map(rowValues)).run();
    }
    const last = messages[messages.length - 1];
    if (last) touchSession(last.sessionId, last.timestamp, tx);
    // The gate is gone, so 'action_required' is no longer true. The resume
    // that follows claims 'running' over whatever this settles on.
    refreshSessionStatus(sessionId, tx);
    return true;
  });
}

export function getTranscriptRows(sessionId: string): TranscriptRow[] {
  return getDb()
    .select()
    .from(sessionTranscript)
    .where(eq(sessionTranscript.sessionId, sessionId))
    .orderBy(asc(sessionTranscript.seq))
    .all()
    .map((r) => ({
      sessionId: r.sessionId,
      kind: r.kind,
      seq: r.seq,
      content: r.content,
      parts: r.canonical?.parts ?? [],
      timestamp: r.timestamp,
      ...(r.clientId !== null && { clientId: r.clientId }),
      ...(r.reminder !== null && { reminder: r.reminder }),
    }));
}

// What a tool call was, read from the transcript that recorded it. Null for a
// synthetic id, which is what a continue request carries: it gates on no tool.
export function findToolCall(
  sessionId: string,
  toolCallId: string,
): { name: string; input: Record<string, unknown> } | null {
  for (const row of getTranscriptRows(sessionId)) {
    for (const part of row.parts) {
      if (part.type === "tool_call" && part.toolCallId === toolCallId) {
        return { name: part.name, input: part.input };
      }
    }
  }
  return null;
}
