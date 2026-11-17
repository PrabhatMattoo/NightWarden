import { randomUUID } from "node:crypto";
import type { NormalizedAlert, SessionMeta } from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import { getAuth } from "../auth/instance.js";
import { getDb } from "../db.js";
import { buildSessionMeta } from "../agent/loop/run-session.js";
import type { Dispatcher } from "../dispatcher.js";
import { admitDelivery } from "../session/alerts-store.js";
import { releaseRun } from "../session/status-store.js";
import { createSession } from "../session/store.js";

// A sender that withheld nothing and described the group not at all: the shape
// every test that is not about the envelope wants.
export const WHOLE_DELIVERY: DeliveryContext = {
  droppedAlerts: 0,
  groupContext: null,
};

// By the only route production has, unlimited because these tests are not about
// the hourly limit, then released so the session reads as idle.
export async function seedAlertSession(
  meta: SessionMeta,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): Promise<void> {
  if (alerts.length === 0) {
    await createSession(meta, true);
    return;
  }
  const admission = await admitDelivery(
    meta,
    groupKey,
    alerts,
    WHOLE_DELIVERY,
    Infinity,
  );
  if (admission.kind !== "started") {
    throw new Error(
      `seedAlertSession opened nothing (${admission.kind}): an alert here is already held and still firing`,
    );
  }
  await releaseRun(meta.sessionId);
}

// The row and its alerts exist before anything dispatches into it, so a test
// that skips this is testing a shape ingest cannot reach.
export async function dispatchAlertSession(
  dispatcher: Dispatcher,
  sessionId: string,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): Promise<boolean> {
  const admission = await admitDelivery(
    buildSessionMeta(sessionId, alerts[0] ?? null, undefined),
    groupKey,
    alerts,
    WHOLE_DELIVERY,
    Infinity,
  );
  if (admission.kind !== "started") return false;
  dispatcher.launch({ sessionId, alerts });
  return true;
}

// A chat session's row, on the same terms: the route writes it before handing
// out the id, so a run dispatched into one always finds it there.
export async function seedChatSession(
  sessionId: string,
  message?: string,
): Promise<void> {
  await createSession(buildSessionMeta(sessionId, null, message));
}

/* A real signed-in session, issued the way production does: the owner is created
   through the signup door, so the cookie is one Better Auth actually issued. */
export async function issueTestSession(
  role: "admin" | "member" = "admin",
): Promise<string> {
  const auth = getAuth();
  const owner = {
    email: "owner@example.test",
    password: "a-long-enough-password",
    name: "Owner",
  };
  const member = { ...owner, email: "member@example.test", name: "Member" };
  const existing = await getDb().selectFrom("user").select("email").execute();
  const emails = new Set(existing.map((row) => row.email));
  if (!emails.has(owner.email)) await auth.api.signUpEmail({ body: owner });
  // Created the way an admin adds a colleague, so it carries the default role.
  if (role === "member" && !emails.has(member.email)) {
    await auth.api.createUser({ body: member });
  }
  const response = await auth.api.signInEmail({
    body: role === "admin" ? owner : member,
    asResponse: true,
  });
  // Returned as a Cookie request header, which is what every caller sends back.
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

// A typed message as the browser sends it, carrying the id the browser mints.
export function messageBody(message: string): string {
  return JSON.stringify({ message, clientMessageId: randomUUID() });
}
