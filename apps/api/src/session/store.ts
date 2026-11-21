import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  InvestigationRecord,
  InvestigationStatus,
  SessionAlert,
  SessionKind,
  SessionMeta,
} from "@nightwarden/shared";
import { getDb } from "../db.js";
import { alertsFor, alertsForMany } from "./alerts-store.js";
import type { PendingHumanInput } from "./gate-store.js";
import { assembleRecord } from "./record-store.js";
import { sessions, sessionTranscript } from "./schema.js";

// The alerts are the durable source of severity-dependent behavior on resume, so
// a run that no longer carries them in its job can recover them from here.
type StoredSession = SessionMeta & {
  alerts: SessionAlert[];
  investigation: boolean;
  lastActivityAt: string;
};

// Create the session row once. Idempotent: a resume re-enters the loop with the
// same id, and the first title wins - later runs never clobber it.
export function createSession(meta: SessionMeta, investigation = false): void {
  getDb()
    .insert(sessions)
    .values({
      sessionId: meta.sessionId,
      title: meta.title,
      investigation,
      createdAt: meta.createdAt,
      lastActivityAt: meta.createdAt,
    })
    .onConflictDoNothing({ target: sessions.sessionId })
    .run();
}

// Overwrites unconditionally: the refined title deliberately replaces the
// temporary first-message title once the run has generated it.
export function updateSessionTitle(sessionId: string, title: string): void {
  getDb()
    .update(sessions)
    .set({ title })
    .where(eq(sessions.sessionId, sessionId))
    .run();
}

// Takes the record columns and the gate with them, and cascades to the transcript.
// Nothing about a session outlives it.
export function deleteSession(sessionId: string): void {
  getDb().delete(sessions).where(eq(sessions.sessionId, sessionId)).run();
}

// Raw material for the sessions queue. The status is read rather than computed:
// the transition that made it true wrote it.
export interface SessionListFacts {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  alerts: SessionAlert[];
  investigation: boolean;
  status: InvestigationStatus;
  record: InvestigationRecord | null;
  // The tail's text, which is why a failed run failed when the status is failed.
  lastContent: string | null;
  // Why the hourly limit left it for a person to start, null when it was not held.
  heldReason: string | null;
  awaitingHumanInput: boolean;
  // What the session is waiting on, null when it waits on nothing.
  pendingKind: PendingHumanInput["kind"] | null;
}

// One page of it. nextOffset is the offset to ask for next, or null once the
// list is exhausted.
interface SessionListFactsPage {
  facts: SessionListFacts[];
  nextOffset: number | null;
}

// What a page is narrowed to; an absent field narrows nothing.
interface SessionListFilter {
  statuses?: readonly InvestigationStatus[];
  titleContains?: string;
}

// A person's search text matched literally, so a typed % or _ finds itself.
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Ordering is the store's, not the frontend's: a waiting session leads the whole
// list, and the id tiebreak stops a row swapping pages between fetches.
export function listSessionFacts(
  limit: number,
  offset: number,
  kind: SessionKind,
  filter: SessionListFilter = {},
): SessionListFactsPage {
  const { statuses, titleContains } = filter;
  const db = getDb();
  const rows = db
    .select({
      sessionId: sessions.sessionId,
      title: sessions.title,
      createdAt: sessions.createdAt,
      investigation: sessions.investigation,
      status: sessions.status,
      candidates: sessions.candidates,
      findings: sessions.findings,
      report: sessions.report,
      recordUpdatedAt: sessions.recordUpdatedAt,
      lastContent: sql<string | null>`${db
        .select({ content: sessionTranscript.content })
        .from(sessionTranscript)
        .where(eq(sessionTranscript.sessionId, sessions.sessionId))
        .orderBy(desc(sessionTranscript.seq))
        .limit(1)}`,
      heldReason: sessions.heldReason,
      lastActivityAt: sessions.lastActivityAt,
      awaitingHumanInput:
        sql<boolean>`(${sessions.awaitingToolUseId} IS NOT NULL)`.mapWith(
          Boolean,
        ),
      pendingKind: sessions.awaitingKind,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.investigation, kind === "investigation"),
        statuses === undefined
          ? undefined
          : inArray(sessions.status, [...statuses]),
        titleContains === undefined
          ? undefined
          : sql`${sessions.title} LIKE ${containsPattern(titleContains)} ESCAPE '\\'`,
      ),
    )
    .orderBy(
      sql`(${sessions.awaitingToolUseId} IS NOT NULL) DESC`,
      sql`${sessions.lastActivityAt} DESC`,
      sessions.sessionId,
    )
    // One extra row answers "is there a next page?" without a second count.
    .limit(limit + 1)
    .offset(offset)
    .all();
  const page = rows.slice(0, limit);
  const alerts = alertsForMany(page.map((r) => r.sessionId));
  return {
    facts: page.map((r) => ({
      sessionId: r.sessionId,
      title: r.title,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      alerts: alerts.get(r.sessionId) ?? [],
      investigation: r.investigation,
      status: r.status,
      record:
        assembleRecord({
          candidates: r.candidates,
          findings: r.findings,
          report: r.report,
          updatedAt: r.recordUpdatedAt,
        }) ?? null,
      lastContent: r.lastContent,
      heldReason: r.heldReason,
      awaitingHumanInput: r.awaitingHumanInput,
      pendingKind: r.pendingKind,
    })),
    nextOffset: rows.length > limit ? offset + page.length : null,
  };
}

// A claim about the whole set, which no page of rows can answer. It is a
// count, so it is counted rather than loaded and measured.
export function countInvestigations(): number {
  return (
    getDb()
      .select({ total: count() })
      .from(sessions)
      .where(eq(sessions.investigation, true))
      .get()?.total ?? 0
  );
}

// Whether the row is there, for callers that only need it to exist. Kept apart
// from getSession so an existence check never pays for the alerts.
export function sessionExists(sessionId: string): boolean {
  return (
    getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .get() !== undefined
  );
}

export function getSession(sessionId: string): StoredSession | undefined {
  const row = getDb()
    .select({
      sessionId: sessions.sessionId,
      title: sessions.title,
      investigation: sessions.investigation,
      createdAt: sessions.createdAt,
      lastActivityAt: sessions.lastActivityAt,
    })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .get();
  if (!row) return undefined;
  return { ...row, alerts: alertsFor(sessionId) };
}
