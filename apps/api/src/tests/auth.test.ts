import { existsSync, readFileSync, statSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { useTempDb } from "./temp-db.js";
import { cookieFrom, sessionOf, signIn } from "./session-helper.js";
import { AccountExistsError, createAccount } from "../auth/accounts.js";
import { resetAuth } from "../auth/instance.js";
import { authSession, user } from "../auth/schema.js";
import { listAuditEvents } from "../audit/audit-store.js";
import { getDb } from "../db.js";
import {
  member,
  organization,
  team,
  teamMember,
} from "../organization/schema.js";
import { createOwner } from "../organization/setup.js";
import { prepareSetup, writeSetupToken } from "../organization/setup-token.js";
import { setupTokenPath } from "../paths.js";
import { buildServer as buildApiServer } from "../server.js";

const OWNER = {
  email: "admin@example.com",
  password: "correcthorsebattery",
  name: "Admin",
};

const ORGANIZATION_NAME = "Acme Ops";

/* What a browser puts on a POST, and what the origin check compares against.
   With no public URL configured the address inject dials is the trusted one. */
const BROWSER_ORIGIN = "http://localhost";

async function buildServer(): Promise<FastifyInstance> {
  const { server } = await buildApiServer();
  await server.ready();
  return server;
}

// The way the setup route adds the owner, for the tests that start after setup.
async function seedOwner(): Promise<void> {
  await createOwner({ ...OWNER, organizationName: ORGANIZATION_NAME });
}

function gated(server: FastifyInstance, cookie: string) {
  return server.inject({
    method: "GET",
    url: "/api/runners",
    headers: { cookie },
  });
}

describe("setup", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let token: string;

  beforeEach(async () => {
    cleanupDb = useTempDb();
    prepareSetup();
    token = readFileSync(setupTokenPath(), "utf8");
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  function setup(body: Record<string, string>) {
    return server.inject({
      method: "POST",
      url: "/api/setup",
      payload: { organizationName: ORGANIZATION_NAME, ...body },
    });
  }

  async function setupRequired(): Promise<boolean> {
    const res = await server.inject({ method: "GET", url: "/api/setup" });
    return (JSON.parse(res.body) as { required: boolean }).required;
  }

  const owners = () => getDb().select().from(user).all();

  it("refuses a wrong token and leaves setup waiting", async () => {
    const res = await setup({ ...OWNER, token: `${token}x` });
    expect(res.statusCode).toBe(403);
    expect(
      (await setup({ ...OWNER, token: "z".repeat(token.length) })).statusCode,
    ).toBe(403);
    expect(owners()).toEqual([]);
    expect(await setupRequired()).toBe(true);
  });

  it("creates the organization, its default team and one admin who is signed in, and nothing opens setup again", async () => {
    expect(await setupRequired()).toBe(true);

    const res = await setup({
      ...OWNER,
      token,
      organizationName: `  ${ORGANIZATION_NAME}  `,
    });
    expect(res.statusCode).toBe(204);
    const cookie = cookieFrom(res);
    expect((await gated(server, cookie)).statusCode).toBe(200);
    expect((await sessionOf(server, cookie))?.role).toBe("admin");
    expect(owners()).toMatchObject([{ email: OWNER.email }]);
    const organizations = getDb().select().from(organization).all();
    expect(organizations).toMatchObject([{ name: ORGANIZATION_NAME }]);
    const members = getDb().select().from(member).all();
    expect(members).toMatchObject([
      { organizationId: organizations[0]?.id, role: "admin" },
    ]);
    // The default team takes the organization's name and holds the owner from the start.
    const teams = getDb().select().from(team).all();
    expect(teams).toMatchObject([{ name: ORGANIZATION_NAME, isDefault: true }]);
    expect(getDb().select().from(teamMember).all()).toMatchObject([
      { teamId: teams[0]?.id, userId: members[0]?.userId },
    ]);
    expect(
      listAuditEvents(10, 0)
        .events.map((event) => [event.action, event.actorEmail])
        .reverse(),
    ).toEqual([
      ["organization_created", OWNER.email],
      ["team_created", OWNER.email],
    ]);
    expect(await setupRequired()).toBe(false);
    expect(existsSync(setupTokenPath())).toBe(false);

    // A token left behind is refused all the same, which is the owner check.
    writeSetupToken(token);
    const again = await setup({
      ...OWNER,
      email: "other@example.com",
      organizationName: "Second",
      token,
    });
    expect(again.statusCode).toBe(409);
    expect(owners()).toHaveLength(1);
    expect(getDb().select().from(organization).all()).toHaveLength(1);
  });

  it("lets exactly one of two simultaneous requests with the token win", async () => {
    const [first, second] = await Promise.all([
      setup({ ...OWNER, token }),
      setup({ ...OWNER, email: "other@example.com", token }),
    ]);
    expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual(
      [204, 403],
    );
    expect(owners()).toHaveLength(1);
  });

  it("keeps the token for a request it refuses before or after claiming it", async () => {
    const short = await setup({ ...OWNER, token, password: "short" });
    expect(short.statusCode).toBe(400);
    // Better Auth caps a password at 128 characters, which the route does not repeat.
    const long = await setup({ ...OWNER, token, password: "a".repeat(129) });
    expect(long.statusCode).toBe(400);
    expect(owners()).toEqual([]);

    expect((await setup({ ...OWNER, token })).statusCode).toBe(204);
  });

  it("closes Better Auth's own sign-up even before the owner exists", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: OWNER,
    });
    // 404 from the router, not Better Auth's own refusal: in-process sign-up is open.
    expect(res.statusCode).toBe(404);
    expect(owners()).toEqual([]);
    expect(await setupRequired()).toBe(true);
  });

  it("writes the token file for an install with no owner and removes it once there is one", async () => {
    expect(statSync(setupTokenPath()).mode & 0o777).toBe(0o600);

    await seedOwner();
    prepareSetup();
    expect(existsSync(setupTokenPath())).toBe(false);
  });
});

describe("accounts made in-process", () => {
  let cleanupDb: () => void;

  beforeEach(() => {
    cleanupDb = useTempDb();
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  /* Better Auth answers a taken email with an invented user once autoSignIn is off,
     so createAccount has to refuse it, and an account is made with no session. */
  it("makes an account with no session and refuses a taken email", async () => {
    await createAccount(OWNER);

    await expect(createAccount(OWNER)).rejects.toThrow(AccountExistsError);
    expect(getDb().select().from(user).all()).toHaveLength(1);
    expect(getDb().select().from(authSession).all()).toEqual([]);
  });

  it("leaves no account behind when the organization cannot be made", async () => {
    getDb()
      .insert(organization)
      .values({
        id: "taken",
        name: "Taken",
        createdAt: new Date().toISOString(),
      })
      .run();

    await expect(
      createOwner({ ...OWNER, organizationName: ORGANIZATION_NAME }),
    ).rejects.toThrow();

    expect(getDb().select().from(user).all()).toEqual([]);
  });
});

describe("the signed-in account", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = await buildServer();
    await seedOwner();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
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
    expect((await sessionOf(server, cookie))?.user.theme).toBe("light");

    expect((await update("sepia")).statusCode).toBe(400);
    expect((await sessionOf(server, cookie))?.user.theme).toBe("light");
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
    expect((await sessionOf(server, cookie))?.user.image).toBe(picture);

    expect((await update(null)).statusCode).toBe(200);
    expect((await sessionOf(server, cookie))?.user.image).toBeNull();
  });

  /* The session is a row, not a signature, so revoking it stops the cookie
     working immediately rather than waiting for it to expire. */
  it("refuses a cookie whose row was revoked", async () => {
    const cookie = cookieFrom(await signIn(server, OWNER));
    expect((await gated(server, cookie)).statusCode).toBe(200);

    const revoked = await server.inject({
      method: "POST",
      url: "/api/auth/revoke-sessions",
      headers: { cookie, origin: BROWSER_ORIGIN },
    });
    expect(revoked.statusCode).toBe(200);

    expect((await gated(server, cookie)).statusCode).toBe(401);
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
    return signIn(server, OWNER, { headers: { origin, cookie: "seen=1" } });
  }

  beforeAll(async () => {
    cleanupDb = useTempDb();
    vi.stubEnv("NIGHTWARDEN_PUBLIC_URL", PUBLIC_URL);
    vi.stubEnv(
      "NIGHTWARDEN_TRUSTED_ORIGINS",
      ` ${NAMED}/ , http://localhost:5173 `,
    );
    resetAuth();
    server = await buildServer();
    await seedOwner();
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
    cleanupDb = useTempDb();
    server = await buildServer();
    await seedOwner();
    cookie = cookieFrom(await signIn(server, OWNER));
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
