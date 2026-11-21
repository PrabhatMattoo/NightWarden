import { asc, eq, max } from "drizzle-orm";
import type { TranscriptRow } from "@nightwarden/shared";
import { getDb, type Db } from "../db.js";
import type { PendingHumanInput } from "./gate-store.js";
import { type OpenTurn, sessions, sessionTranscript } from "./schema.js";
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

/* Called when suspending on a gate, so the database is always consistent: the
   rows, the gate and the turn it interrupted exist together, or none does. */
export function appendRowsAndPark(
  messages: TranscriptRow[],
  gate: Omit<PendingHumanInput, "askedAt">,
  turn: OpenTurn | null,
): void {
  getDb().transaction((tx) => {
    if (messages.length > 0) {
      tx.insert(sessionTranscript).values(messages.map(rowValues)).run();
    }
    const now = new Date().toISOString();
    // Suspending is the gate, so the status saying this session waits is
    // written with it: the two are columns on the same row.
    tx.update(sessions)
      .set({
        status: "action_required",
        awaitingToolUseId: gate.toolCallId,
        awaitingKind: gate.kind,
        awaitingSince: now,
        openTurn: turn,
        lastActivityAt: now,
      })
      .where(eq(sessions.sessionId, gate.sessionId))
      .run();
  });
}

// The turn's last answers and the close of its open turn in one transaction, so
// a crash cannot leave the answers written and the turn still open.
export function appendRowsAndCloseTurn(messages: TranscriptRow[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  getDb().transaction((tx) => {
    tx.insert(sessionTranscript).values(messages.map(rowValues)).run();
    tx.update(sessions)
      .set({ openTurn: null })
      .where(eq(sessions.sessionId, last.sessionId))
      .run();
    touchSession(last.sessionId, last.timestamp, tx);
    refreshSessionStatus(last.sessionId, tx);
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
