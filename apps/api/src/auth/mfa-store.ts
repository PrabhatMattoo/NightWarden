import { eq } from "drizzle-orm";
import type { Actor } from "@nightwarden/shared";
import { recordAuditEvent } from "../audit/audit-store.js";
import { getDb } from "../db.js";
import { twoFactor, user } from "./schema.js";

export class MfaNotSetUpError extends Error {
  constructor() {
    super("This person has not set up MFA.");
  }
}

// The secret, codes and flag go together, so no account reads enrolled without them.
export function resetMfa(userId: string, actor: Actor): void {
  getDb().transaction((tx) => {
    const person = tx
      .select({ email: user.email, enabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    if (person === undefined || !person.enabled) throw new MfaNotSetUpError();
    tx.delete(twoFactor).where(eq(twoFactor.userId, userId)).run();
    tx.update(user)
      .set({ twoFactorEnabled: false })
      .where(eq(user.id, userId))
      .run();
    recordAuditEvent(
      {
        actor,
        action: "mfa_reset",
        target: person.email,
        details: { email: person.email },
        sessionId: null,
      },
      tx,
    );
  });
}
