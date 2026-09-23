import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AuthStatusResponse } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { resetAuth } from "../auth/instance.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { requireSession } from "../auth/session.js";
import { mountApi } from "./api-server.js";

const OWNER = {
  email: "admin@example.com",
  password: "correcthorsebattery",
  name: "Admin",
};

/* What a browser puts on a POST, and what the origin check compares against.
   With no public URL configured the address inject dials is the trusted one. */
const BROWSER_ORIGIN = "http://localhost";

async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false, trustProxy: true });
  await mountApi(server, registerAuthRoutes);
  server.get("/protected", { preHandler: requireSession }, async () => ({
    ok: true,
  }));
  await server.ready();
  return server;
}

function signUp(server: FastifyInstance, payload: Record<string, string>) {
  return server.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload,
  });
}

function signIn(
  server: FastifyInstance,
  payload: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return server.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload,
    headers,
  });
}

// The Set-Cookie values as a Cookie request header, which is what a browser
// sends back and what every authenticated call here needs.
function cookieFrom(res: { headers: { "set-cookie"?: string | string[] } }) {
  const raw = res.headers["set-cookie"] ?? [];
  const all = Array.isArray(raw) ? raw : [raw];
  return all.map((c) => c.split(";")[0]).join("; ");
}

function status(server: FastifyInstance, cookie?: string) {
  return server.inject({
    method: "GET",
    url: "/api/auth-status",
    ...(cookie !== undefined && { headers: { cookie } }),
  });
}

describe("the first account", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("creates the owner and sets a session cookie", async () => {
    const res = await signUp(server, OWNER);
    expect(res.statusCode).toBe(200);
    expect(cookieFrom(res)).not.toBe("");
  });

  // The install has one owner and everyone after arrives by invitation, so the
  // signup door closes the moment it has been used.
  it("refuses a second account", async () => {
    const res = await signUp(server, {
      email: "other@example.com",
      password: "anotherpassword123",
      name: "Other",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const after = await status(server);
    expect(JSON.parse(after.body)).toMatchObject({ ownerExists: true });
  });

  it("makes that first account an admin", async () => {
    const res = await signIn(server, OWNER);
    const session = JSON.parse(res.body) as { user?: { role?: string } };
    expect(session.user?.role).toBe("admin");
  });

  /* An admin adding a colleague is not self-registration, so the rule that
     closes the door must not close it on them - which is how invitations work. */
  it("lets an admin create an account once the door is shut", async () => {
    const cookie = cookieFrom(await signIn(server, OWNER));
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/admin/create-user",
      headers: { cookie, origin: BROWSER_ORIGIN },
      payload: {
        email: "colleague@example.com",
        password: "another-long-password",
        name: "Colleague",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  // The role stamp belongs to the first account alone.
  it("leaves an admin-created account off the admin role", async () => {
    const cookie = cookieFrom(await signIn(server, OWNER));
    const res = await server.inject({
      method: "GET",
      url: "/api/auth/admin/list-users?limit=10",
      headers: { cookie },
    });
    const { users } = JSON.parse(res.body) as {
      users: Array<{ email: string; role: string | null }>;
    };
    const colleague = users.find((u) => u.email === "colleague@example.com");
    expect(colleague?.role).toBe("user");
  });
});

describe("GET /auth-status", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("reports no owner before setup", async () => {
    const res = await status(server);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ownerExists: false });
  });

  it("reports an owner but no session once one exists", async () => {
    await signUp(server, OWNER);
    const res = await status(server);
    expect(JSON.parse(res.body)).toEqual({
      ownerExists: true,
      authenticated: false,
    });
  });

  it("reports no session for a garbage cookie", async () => {
    const res = await status(server, "better-auth.session_token=garbage");
    expect(JSON.parse(res.body)).toEqual({
      ownerExists: true,
      authenticated: false,
    });
  });

  it("reports the signed-in email, name and theme for a valid cookie", async () => {
    const signedIn = await signIn(server, OWNER);
    const res = await status(server, cookieFrom(signedIn));
    expect(JSON.parse(res.body) as AuthStatusResponse).toEqual({
      ownerExists: true,
      authenticated: true,
      email: OWNER.email,
      name: OWNER.name,
      theme: "system",
    });
  });

  // The account holds the choice, so every browser signed in to it agrees.
  it("keeps a chosen theme on the account and refuses one it does not know", async () => {
    const cookie = cookieFrom(await signIn(server, OWNER));
    const update = (theme: string) =>
      server.inject({
        method: "POST",
        url: "/api/auth/update-user",
        headers: { cookie, origin: BROWSER_ORIGIN },
        payload: { theme },
      });

    expect((await update("light")).statusCode).toBe(200);
    expect(JSON.parse((await status(server, cookie)).body)).toMatchObject({
      theme: "light",
    });

    expect((await update("sepia")).statusCode).toBe(400);
    expect(JSON.parse((await status(server, cookie)).body)).toMatchObject({
      theme: "light",
    });
  });

  /* The session is a row, not a signature, so revoking it stops the cookie
     working immediately rather than waiting for it to expire. */
  it("reports no session for a cookie whose row was revoked", async () => {
    const signedIn = await signIn(server, OWNER);
    const cookie = cookieFrom(signedIn);

    const revoked = await server.inject({
      method: "POST",
      url: "/api/auth/revoke-sessions",
      headers: { cookie, origin: BROWSER_ORIGIN },
    });
    expect(revoked.statusCode).toBe(200);

    const res = await status(server, cookie);
    expect(JSON.parse(res.body)).toEqual({
      ownerExists: true,
      authenticated: false,
    });
  });
});

describe("signing in", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    server = await buildServer();
    await signUp(server, OWNER);
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("sets a session cookie on the right credentials", async () => {
    const res = await signIn(server, OWNER);
    expect(res.statusCode).toBe(200);
    expect(cookieFrom(res)).not.toBe("");
  });
});

/* Better Auth validates the Origin header on a request carrying cookies, so the
   trusted list decides which addresses a person can sign in from. */
describe("trusted origins", () => {
  const PUBLIC_URL = "http://nightwarden.example.com";
  const NAMED = "http://ops.example.com";
  let server: FastifyInstance;
  let cleanupDb: () => void;

  function signInFrom(origin: string) {
    return signIn(server, OWNER, { origin, cookie: "seen=1" });
  }

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    vi.stubEnv("NIGHTWARDEN_PUBLIC_URL", PUBLIC_URL);
    vi.stubEnv(
      "NIGHTWARDEN_TRUSTED_ORIGINS",
      ` ${NAMED}/ , http://localhost:5173 `,
    );
    resetAuth();
    server = await buildServer();
    await signUp(server, OWNER);
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("signs in from the public URL", async () => {
    expect((await signInFrom(PUBLIC_URL)).statusCode).toBe(200);
  });

  // The whole point of the variable: a second address for the people, where the
  // servers keep the one they dial back on.
  it("signs in from an address the variable names", async () => {
    expect((await signInFrom(NAMED)).statusCode).toBe(200);
    expect((await signInFrom("http://localhost:5173")).statusCode).toBe(200);
  });

  it("refuses an address nothing named", async () => {
    expect((await signInFrom("http://elsewhere.example.com")).statusCode).toBe(
      403,
    );
  });
});

describe("requireSession gate", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let cookie: string;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    server = await buildServer();
    cookie = cookieFrom(await signUp(server, OWNER));
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("lets a valid cookie through", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a tampered cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: cookie.slice(0, -4) + "XXXX" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a request with no cookie", async () => {
    const res = await server.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });
});
