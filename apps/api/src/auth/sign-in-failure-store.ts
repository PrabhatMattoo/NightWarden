// Times are ISO-8601 strings; recording drops every row older than `keepSince`.
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../db.js";
import { signInFailure } from "./schema.js";

export function recordSignInFailure(
  email: string,
  failedAt: string,
  keepSince: string,
): void {
  const db = getDb();
  db.delete(signInFailure).where(lt(signInFailure.failedAt, keepSince)).run();
  db.insert(signInFailure).values({ email, failedAt }).run();
}

export function signInFailuresSince(email: string, since: string): string[] {
  return getDb()
    .select({ failedAt: signInFailure.failedAt })
    .from(signInFailure)
    .where(
      and(eq(signInFailure.email, email), gte(signInFailure.failedAt, since)),
    )
    .orderBy(asc(signInFailure.failedAt))
    .all()
    .map((row) => row.failedAt);
}

export function clearSignInFailures(email: string): void {
  getDb().delete(signInFailure).where(eq(signInFailure.email, email)).run();
}
