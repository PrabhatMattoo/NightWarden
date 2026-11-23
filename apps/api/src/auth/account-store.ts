import { eq } from "drizzle-orm";
import { type Db, getDb } from "../db.js";
import { authSession, user } from "./schema.js";

export function userIdByEmail(email: string): string | undefined {
  return getDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .get()?.id;
}

// Takes the Db so ending someone's sessions can share a transaction with the change that calls for it.
export function deleteSessionsOf(userId: string, db: Db = getDb()): void {
  db.delete(authSession).where(eq(authSession.userId, userId)).run();
}

export function deleteUser(userId: string): void {
  getDb().delete(user).where(eq(user.id, userId)).run();
}
