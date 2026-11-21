import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { FailureKind, InvestigationStatus } from "@nightwarden/shared";
import { getDb, type Db } from "../db.js";
import { alerts, sessionTranscript, sessions } from "./schema.js";

// `running` is the one value no stored row can confirm, so it is claimed by a
// conditional UPDATE that doubles as the dispatch mutex.

interface StatusFacts {
  gated: boolean;
  held: boolean;
  stoppedAt: string | null;
  alerts: number;
  openAlerts: number;
  lastKind: string | null;
}

function facts(sessionId: string, db: Db): StatusFacts | undefined {
  return db
    .select({
      gated: sql<boolean>`(${sessions.awaitingToolUseId} IS NOT NULL)`.mapWith(
        Boolean,
      ),
      held: sql<boolean>`(${sessions.heldReason} IS NOT NULL)`.mapWith(Boolean),
      stoppedAt: sessions.stoppedAt,
      alerts: db.$count(alerts, eq(alerts.sessionId, sessions.sessionId)),
      openAlerts: db.$count(
        alerts,
        and(eq(alerts.sessionId, sessions.sessionId), isNull(alerts.clearedAt)),
      ),
      lastKind: sql<string | null>`${db
        .select({ kind: sessionTranscript.kind })
        .from(sessionTranscript)
        .where(eq(sessionTranscript.sessionId, sessions.sessionId))
        .orderBy(desc(sessionTranscript.seq))
        .limit(1)}`,
    })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .get();
}

// The order is the meaning: a gate leads because someone is being asked
// something now, and a recovered incident outranks who ended the run.
function statusFrom(f: StatusFacts): InvestigationStatus {
  if (f.gated) return "action_required";
  // A session that fired on no alert has no condition to recover, so the alert
  // count is checked as well as the open count.
  if (f.alerts > 0 && f.openAlerts === 0) return "resolved";
  // Held and never run: once a Start has run, the transcript holds a row.
  if (f.held && f.lastKind === null) return "not_started";
  if (f.stoppedAt !== null) return "stopped";
  if (f.lastKind === "error") return "failed";
  return "completed";
}

export function deriveStatus(
  sessionId: string,
  db: Db = getDb(),
): InvestigationStatus {
  const f = facts(sessionId, db);
  return f === undefined ? "completed" : statusFrom(f);
}

// Guarded, so a transition elsewhere cannot pull a live run out of `running`.
export function refreshSessionStatus(
  sessionId: string,
  db: Db = getDb(),
): void {
  db.update(sessions)
    .set({ status: deriveStatus(sessionId, db) })
    .where(
      and(eq(sessions.sessionId, sessionId), ne(sessions.status, "running")),
    )
    .run();
}

// The conditional UPDATE is the whole mutex: two racing dispatches attempt it
// and one changes a row. Every status but 'running' is claimable.
export function claimRun(sessionId: string, db: Db = getDb()): boolean {
  return (
    db
      .update(sessions)
      .set({ status: "running", stoppedAt: null })
      .where(
        and(eq(sessions.sessionId, sessionId), ne(sessions.status, "running")),
      )
      .run().changes > 0
  );
}

// Recorded when it happens, because a stopped run reaches the same end as one
// that ran out of ideas and blaming the agent is a different claim.
export function markStopped(sessionId: string): void {
  getDb()
    .update(sessions)
    .set({ stoppedAt: new Date().toISOString() })
    .where(eq(sessions.sessionId, sessionId))
    .run();
  refreshSessionStatus(sessionId);
}

// Conditional on 'running' so it cannot overwrite the 'action_required' written
// with the interrupt row: that session is waiting, not idle.
export function releaseRun(sessionId: string): void {
  getDb()
    .update(sessions)
    .set({ status: deriveStatus(sessionId) })
    .where(
      and(eq(sessions.sessionId, sessionId), eq(sessions.status, "running")),
    )
    .run();
}

// Recorded at the failure, because describeLLMError's prose cannot be
// classified afterwards and a bad key must never be retried.
export function recordRunFailure(sessionId: string, kind: FailureKind): void {
  getDb()
    .update(sessions)
    .set({
      failureKind: kind,
      failedAttempts: sql`${sessions.failedAttempts} + 1`,
    })
    .where(eq(sessions.sessionId, sessionId))
    .run();
}

// A run that got somewhere clears the record, so a later unrelated failure gets
// its own three attempts rather than inheriting a spent count.
export function clearRunFailure(sessionId: string): void {
  getDb()
    .update(sessions)
    .set({ failureKind: null, failedAttempts: 0 })
    .where(
      and(eq(sessions.sessionId, sessionId), isNotNull(sessions.failureKind)),
    )
    .run();
}

export function runFailure(
  sessionId: string,
): { kind: string; attempts: number } | undefined {
  const row = getDb()
    .select({ kind: sessions.failureKind, attempts: sessions.failedAttempts })
    .from(sessions)
    .where(
      and(eq(sessions.sessionId, sessionId), isNotNull(sessions.failureKind)),
    )
    .get();
  return row?.kind == null
    ? undefined
    : { kind: row.kind, attempts: row.attempts };
}

/* Unconditional, unlike releaseRun: boot recovery settles a session left
   waiting on nobody, which releaseRun leaves alone. */
export function markDone(sessionId: string): void {
  getDb()
    .update(sessions)
    .set({ status: deriveStatus(sessionId) })
    .where(eq(sessions.sessionId, sessionId))
    .run();
}

export function isRunning(sessionId: string): boolean {
  return (
    getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(
        and(eq(sessions.sessionId, sessionId), eq(sessions.status, "running")),
      )
      .get() !== undefined
  );
}

// Approving clears the gate before the resume claims the run, so a crash in
// that gap leaves a session reading action_required while waiting on nobody.
export function abandonedSessionIds(): string[] {
  return getDb()
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(eq(sessions.status, "action_required"))
    .all()
    .map((r) => r.sessionId);
}

// Read once at boot, where every one of them is a run this process cannot be
// running: it has only just started.
export function runningSessionIds(): string[] {
  return getDb()
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(eq(sessions.status, "running"))
    .all()
    .map((r) => r.sessionId);
}
