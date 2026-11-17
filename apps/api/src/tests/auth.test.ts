import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthStatusResponse } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { getAuth, resetAuth } from "../auth/instance.js";
import { getDb } from "../db.js";
import { buildServer as buildApiServer } from "../server.js";

const OWNER = {
  email: "admin@example.com",
  password: "correcthorsebattery",
  name: "Admin",
};

/* What a browser puts on a POST, and what the origin check compares against.
   With no public URL configured the address inject dials is the trusted one. */
const BROWSER_ORIGIN = "http://localhost";

async function buildServer(): Promise<FastifyInstance> {
  const { server } = await buildApiServer();
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
  it("lets an admin's server-side call add a member once the door is shut", async () => {
    await getAuth().api.createUser({
      body: {
        email: "colleague@example.com",
        password: "another-long-password",
        name: "Colleague",
      },
    });
    const colleague = await getDb()
      .selectFrom("user")
      .select("role")
      .where("email", "=", "colleague@example.com")
      .executeTakeFirst();
    expect(colleague?.role).toBe("member");
  });

  // Nothing in NightWarden calls the admin plugin over HTTP, impersonation least of all.
  it("answers none of the admin plugin's paths, however the URL is spelled", async () => {
    const cookie = cookieFrom(await signIn(server, OWNER));
    for (const path of ["admin/impersonate-user", "admin/create-user"]) {
      for (const url of [`/api/auth/${path}`, `/api/auth//${path}`]) {
        const res = await server.inject({
          method: "POST",
          url,
          headers: { cookie, origin: BROWSER_ORIGIN },
          payload: { userId: "x", email: "x@example.com", password: "x" },
        });
        expect(res.statusCode, url).toBe(404);
      }
    }
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

  it("reports the signed-in email, name and theme for a valid cookie", async () => {
    const signedIn = await signIn(server, OWNER);
    const res = await status(server, cookieFrom(signedIn));
    expect(JSON.parse(res.body) as AuthStatusResponse).toEqual({
      ownerExists: true,
      authenticated: true,
      email: OWNER.email,
      name: OWNER.name,
      image: null,
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

  // Drawn as an <img> on every page, so only a small inline picture is kept.
  it("keeps an inline picture on the account and refuses a link or anything oversized", async () => {
    const cookie = cookieFrom(await signIn(server, OWNER));
    const update = (image: string | null) =>
      server.inject({
        method: "POST",
        url: "/api/auth/update-user",
        headers: { cookie, origin: BROWSER_ORIGIN },
        payload: { image },
      });
    const picture = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4";

    expect((await update(picture)).statusCode).toBe(200);
    expect((await update("https://example.com/me.png")).statusCode).toBe(400);
    expect(
      (await update(`data:image/png;base64,${"A".repeat(200_000)}`)).statusCode,
    ).toBe(400);
    expect(JSON.parse((await status(server, cookie)).body)).toMatchObject({
      image: picture,
    });

    expect((await update(null)).statusCode).toBe(200);
    expect(JSON.parse((await status(server, cookie)).body)).toMatchObject({
      image: null,
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

describe("the authorization gate", () => {
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

  it("refuses a tampered cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: cookie.slice(0, -4) + "XXXX" },
    });
    expect(res.statusCode).toBe(401);
  });
});
