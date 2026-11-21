import { eq } from "drizzle-orm";
import type { InvestigationRecord } from "@nightwarden/shared";
import { getDb, type Db } from "../db.js";
import { sessions } from "./schema.js";

type RecordRow = Omit<InvestigationRecord, "updatedAt"> & {
  updatedAt: string | null;
};

// The one place the columns become a record, so the session list's own query
// assembles it the same way. Nothing recorded reads as absent, not empty.
export function assembleRecord(
  row: RecordRow | undefined,
): InvestigationRecord | undefined {
  if (row === undefined) return undefined;
  const { candidates, findings, report } = row;
  if (candidates.length === 0 && findings.length === 0 && report === null) {
    return undefined;
  }
  return {
    candidates,
    findings,
    report,
    updatedAt: row.updatedAt ?? new Date(0).toISOString(),
  };
}

export function getRecord(
  sessionId: string,
  db: Db = getDb(),
): InvestigationRecord | undefined {
  return assembleRecord(
    db
      .select({
        candidates: sessions.candidates,
        findings: sessions.findings,
        report: sessions.report,
        updatedAt: sessions.recordUpdatedAt,
      })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .get(),
  );
}

function emptyRecord(): InvestigationRecord {
  return {
    candidates: [],
    findings: [],
    report: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function write(sessionId: string, record: InvestigationRecord, db: Db): void {
  db.update(sessions)
    .set({
      candidates: record.candidates,
      findings: record.findings,
      report: record.report,
      recordUpdatedAt: new Date().toISOString(),
    })
    .where(eq(sessions.sessionId, sessionId))
    .run();
}

// Read-modify-write in a transaction, so two calls in the same turn cannot lose
// each other's write.
export function updateRecord<T>(
  sessionId: string,
  apply: (record: InvestigationRecord) => {
    next: InvestigationRecord;
    value: T;
  },
): T {
  return getDb().transaction((tx) => {
    const { next, value } = apply(getRecord(sessionId, tx) ?? emptyRecord());
    write(sessionId, next, tx);
    return value;
  });
}

// The same, for an act that may refuse: `apply` returns null to leave the row
// untouched. Returns whether it wrote.
export function amendRecord(
  sessionId: string,
  apply: (record: InvestigationRecord) => InvestigationRecord | null,
): boolean {
  return getDb().transaction((tx) => {
    const next = apply(getRecord(sessionId, tx) ?? emptyRecord());
    if (next === null) return false;
    write(sessionId, next, tx);
    return true;
  });
}
