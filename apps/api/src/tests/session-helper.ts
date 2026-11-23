import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ADMIN_ROLE,
  ROLE_NAMES,
  type Actor,
  type NormalizedAlert,
  type RoleName,
  type SessionMeta,
} from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import { userIdByEmail } from "../auth/account-store.js";
import { createAccount } from "../auth/accounts.js";
import { getAuth } from "../auth/instance.js";
import { user } from "../auth/schema.js";
import { getDb } from "../db.js";
import { buildSessionMeta } from "../agent/loop/run-session.js";
import type { Dispatcher } from "../dispatcher.js";
import {
  addMember,
  organizationExists,
} from "../organization/organization-store.js";
import { createOwner } from "../organization/setup.js";
import { admitDelivery } from "../session/alerts-store.js";
import type { OpenTurn } from "../session/schema.js";
import { releaseRun } from "../session/status-store.js";
import { createSession } from "../session/store.js";

// A sender that withheld nothing and described the group not at all: the shape
// every test that is not about the envelope wants.
export const WHOLE_DELIVERY: DeliveryContext = {
  droppedAlerts: 0,
  groupContext: null,
};

// What a run parks with when the first call of its turn is the gate.
export const UNANSWERED_TURN: OpenTurn = {
  stage: "conversation",
  results: [],
  decisions: [],
};

// By the only route production has, unlimited because these tests are not about
// the hourly limit, then released so the session reads as idle.
export function seedAlertSession(
  meta: SessionMeta,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): void {
  if (alerts.length === 0) {
    createSession(meta, true);
    return;
  }
  const admission = admitDelivery(
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
  releaseRun(meta.sessionId);
}

// The row and its alerts exist before anything dispatches into it, so a test
// that skips this is testing a shape ingest cannot reach.
export function dispatchAlertSession(
  dispatcher: Dispatcher,
  sessionId: string,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): boolean {
  const admission = admitDelivery(
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
export function seedChatSession(
  sessionId: string,
  message?: string,
  createdBy?: string,
): void {
  createSession(buildSessionMeta(sessionId, null, message), false, createdBy);
}

// A bare account, for a test that needs someone to own a chat without signing in.
export function insertTestUser(): string {
  const id = randomUUID();
  const now = new Date();
  getDb()
    .insert(user)
    .values({
      id,
      name: "Test",
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

// The admin these tests act as, who adds every colleague.
export function ownerActor(): Actor {
  return {
    id: accountId(TEST_OWNER.email),
    name: TEST_OWNER.name,
    email: TEST_OWNER.email,
  };
}

// The id behind issueTestSession's cookie, so a chat can be seeded as theirs.
export function accountId(email: string): string {
  const row = getDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .get();
  if (row === undefined) throw new Error(`no test account for ${email}`);
  return row.id;
}

export const TEST_OWNER = {
  email: "owner@example.test",
  password: "a-long-enough-password",
  name: "Owner",
};
export const TEST_MEMBER = {
  ...TEST_OWNER,
  email: "member@example.test",
  name: "Member",
};

const TEST_VIEWER = {
  ...TEST_OWNER,
  email: "viewer@example.test",
  name: "Viewer",
};

const ACCOUNT_FOR_ROLE = {
  admin: TEST_OWNER,
  member: TEST_MEMBER,
  viewer: TEST_VIEWER,
};

/* A real signed-in session: the owner is created the way the setup route does, so
   the cookie is one Better Auth actually issued. Another role is a colleague an admin added. */
export async function issueTestSession(
  role: RoleName = ADMIN_ROLE,
): Promise<string> {
  if (!organizationExists()) {
    await createOwner({ ...TEST_OWNER, organizationName: "Test Organization" });
  }
  const account = ACCOUNT_FOR_ROLE[role];
  if (userIdByEmail(account.email) === undefined) {
    const userId = await createAccount(account);
    addMember(userId, role, ownerActor());
  }
  const response = await getAuth().api.signInEmail({
    body: account,
    asResponse: true,
  });
  return cookieFrom(response);
}

// What a browser puts on a POST, and what the origin check compares against.
export const BROWSER_ORIGIN = "http://localhost";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

// The Set-Cookie values a browser keeps, as the Cookie header it sends back; a cleared one is dropped.
export function cookieFrom(res: {
  headers: { "set-cookie"?: string | string[] } | Headers;
}): string {
  const raw =
    res.headers instanceof Headers
      ? res.headers.getSetCookie()
      : (res.headers["set-cookie"] ?? []);
  return (Array.isArray(raw) ? raw : [raw])
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

export function signIn(
  server: FastifyInstance,
  body: { email: string; password?: string },
  options: { headers?: Record<string, string>; remoteAddress?: string } = {},
) {
  return server.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    ...(options.remoteAddress !== undefined && {
      remoteAddress: options.remoteAddress,
    }),
    headers: { origin: BROWSER_ORIGIN, ...options.headers },
    payload: body,
  });
}

const sessionSchema = z
  .object({
    role: z.enum(ROLE_NAMES).nullable(),
    mfaRequired: z.boolean(),
    user: z.object({
      theme: z.string(),
      image: z.string().nullable(),
      twoFactorEnabled: z.boolean(),
    }),
  })
  .nullable();

// What /get-session tells the browser about a cookie: its role and account, or null for a stranger.
export async function sessionOf(server: FastifyInstance, cookie: string) {
  const res = await server.inject({
    method: "GET",
    url: "/api/auth/get-session",
    headers: { cookie },
  });
  return sessionSchema.parse(JSON.parse(res.body));
}

export function call(
  server: FastifyInstance,
  method: Method,
  url: string,
  cookie: string | null,
  payload?: Record<string, unknown>,
  options: { headers?: Record<string, string>; remoteAddress?: string } = {},
) {
  return server.inject({
    method,
    url,
    ...(options.remoteAddress !== undefined && {
      remoteAddress: options.remoteAddress,
    }),
    headers: { ...options.headers, ...(cookie !== null && { cookie }) },
    ...(payload !== undefined && { payload }),
  });
}

// A typed message as the browser sends it, carrying the id the browser mints.
export function messageBody(message: string): string {
  return JSON.stringify({ message, clientMessageId: randomUUID() });
}
