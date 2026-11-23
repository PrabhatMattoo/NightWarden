import { fakeModel } from "./fake-model.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance, FastifySchema } from "fastify";
import { registerApi } from "../api.js";
import { dispatcherFor } from "../server.js";
import { installAuthorization } from "../auth/authorize.js";
import { issueTestSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";

// One walk of the whole surface, so tomorrow's route is covered. A route not
// named below has to refuse an anonymous caller.
const PUBLIC: ReadonlyArray<{ route: string; why: string }> = [
  {
    route: "GET /api/auth/*",
    why: "Better Auth's own surface, which sign-in must reach without a session",
  },
  {
    route: "POST /api/auth/*",
    why: "the same, and where sign-in is answered",
  },
  {
    route: "GET /api/setup",
    why: "answers whether the install still waits for its owner",
  },
  { route: "POST /api/setup", why: "claims its own setup token" },
  {
    route: "GET /api/sign-in-options",
    why: "answers whether a forgotten password can be emailed, before anyone is signed in",
  },
  {
    route: "GET /api/invitations/:token",
    why: "the token is a random secret mailed to its recipient, who has no account to sign in with",
  },
  {
    route: "POST /api/invitations/:token/accept",
    why: "the token is its own credential, and an existing account must also be signed in as the invited address",
  },
  { route: "POST /api/alerts/ingest", why: "verifies its own issued token" },
  { route: "GET /api/clients/connect", why: "a runner presents its own token" },
];

const PUBLIC_ROUTES = new Set(PUBLIC.map((entry) => entry.route));

// A member chats, investigates and approves writes; what changes the install
// itself, reads its settings or audit trail, or manages its people is an admin's.
// Deleting an investigation is too, but the session guard enforces that once the id names one.
const ADMIN_ONLY = [
  "GET /api/config",
  "PATCH /api/organization",
  "GET /api/organization/members",
  "PATCH /api/organization/members/:id",
  "DELETE /api/organization/members/:id",
  "GET /api/organization/invitations",
  "POST /api/organization/invitations",
  "DELETE /api/organization/invitations/:id",
  "GET /api/organization/teams",
  "POST /api/organization/teams",
  "PATCH /api/organization/teams/:id",
  "DELETE /api/organization/teams/:id",
  "POST /api/organization/teams/:id/members",
  "DELETE /api/organization/teams/:id/members/:userId",
  "POST /api/runners",
  "DELETE /api/runners/:id",
  "GET /api/runners/install",
  "GET /api/audit",
  "PATCH /api/config",
  "POST /api/config/models",
  "POST /api/config/model-check",
  "PATCH /api/config/key",
  "GET /api/config/mail",
  "PUT /api/config/mail",
  "POST /api/integrations/github/preflight",
  "POST /api/integrations/github/repos",
  "POST /api/integrations/github",
  "PATCH /api/integrations/github",
  "POST /api/integrations/github/test",
  "DELETE /api/integrations/github",
  "POST /api/integrations/loki",
  "POST /api/integrations/loki/test",
  "DELETE /api/integrations/loki",
  "POST /api/integrations/sentry",
  "POST /api/integrations/sentry/test",
  "DELETE /api/integrations/sentry",
  "POST /api/integrations/alerting/:kind/credential",
  "DELETE /api/integrations/alerting/:kind",
  "POST /api/integrations/metrics",
  "POST /api/integrations/metrics/test",
  "DELETE /api/integrations/metrics",
].sort();

// A viewer only reads investigations (and the organization's name, which every
// page shows); the event stream is one more, left out of the sweep like any stream.
const VIEWER_ALLOWED = [
  "GET /api/organization",
  "GET /api/sessions",
  "GET /api/sessions/:id",
  "GET /api/sessions/:id/report",
].sort();

// A concrete value for every path parameter, so the request reaches the guard
// rather than dying in routing.
const STAND_INS: Record<string, string> = {
  id: "00000000-0000-4000-8000-000000000000",
  kind: "alertmanager",
  platform: "docker",
  userId: "00000000-0000-4000-8000-000000000001",
};

function fill(url: string): string {
  return url.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = STAND_INS[name];
    if (value === undefined) throw new Error(`no stand-in for :${name}`);
    return value;
  });
}

describe("the route surface", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  const routes: Array<{
    method: string;
    url: string;
    schema: FastifySchema | undefined;
    streams: boolean;
  }> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = Fastify({ logger: false });
    server.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      for (const method of methods) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        routes.push({
          method,
          url: route.url,
          schema: route.schema,
          streams: route.sse !== undefined,
        });
      }
    });
    // Hooked before the routes register, so it registers them itself.
    await registerApi(server, {
      dispatcher: dispatcherFor(fakeModel().modelFor),
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("finds the whole surface, so this is not passing on an empty list", () => {
    expect(routes.length).toBeGreaterThan(25);
  });

  function send(method: string, url: string, cookie?: string) {
    return server.inject({
      method: method as "GET",
      url: fill(url),
      payload: method === "GET" ? undefined : {},
      ...(cookie !== undefined && { headers: { cookie } }),
    });
  }

  it("answers 401 on every route that is not deliberately public", async () => {
    const allowed: string[] = [];
    for (const { method, url } of routes) {
      const route = `${method} ${url}`;
      if (PUBLIC_ROUTES.has(route)) continue;
      const res = await send(method, url);
      if (res.statusCode !== 401) allowed.push(`${route} -> ${res.statusCode}`);
    }
    expect(allowed).toEqual([]);
  });

  it("refuses a member exactly the routes reserved for an admin", async () => {
    const member = await issueTestSession("member");
    const refused: string[] = [];
    for (const { method, url, streams } of routes) {
      const route = `${method} ${url}`;
      // A stream a member may open never ends, so inject would wait forever.
      if (PUBLIC_ROUTES.has(route) || streams) continue;
      if ((await send(method, url, member)).statusCode === 403) {
        refused.push(route);
      }
    }
    expect(refused.sort()).toEqual(ADMIN_ONLY);
  });

  it("refuses a viewer every route but the ones that read investigations", async () => {
    const viewer = await issueTestSession("viewer");
    const reached: string[] = [];
    for (const { method, url, streams } of routes) {
      const route = `${method} ${url}`;
      if (PUBLIC_ROUTES.has(route) || streams) continue;
      if ((await send(method, url, viewer)).statusCode !== 403) {
        reached.push(route);
      }
    }
    expect(reached.sort()).toEqual(VIEWER_ALLOWED);
  });

  // Checked as each route registers, so an undeclared one stops the boot.
  it("refuses to register a route that declares no permission", async () => {
    const bare = Fastify({ logger: false });
    await expect(
      bare.register(async (api) => {
        installAuthorization(api);
        api.get("/undeclared", async () => ({ ok: true }));
      }),
    ).rejects.toThrow(/permission/);
    await bare.close();
  });

  /* The serializer encodes a reply through the schema for its status and drops
     any field it does not name, so a route without one would send everything. */
  it("declares the success and refusal bodies of every route OpenAPI describes", () => {
    const undeclared = routes
      .filter(({ schema }) => schema?.hide !== true)
      .filter(({ schema }) => {
        const response = schema?.response;
        if (typeof response !== "object" || response === null) return true;
        const codes = Object.keys(response);
        const refuses = codes.includes("4xx") && codes.includes("5xx");
        return !refuses || !codes.some((c) => c.startsWith("2"));
      })
      .map(({ method, url }) => `${method} ${url}`);
    expect(undeclared).toEqual([]);
  });

  /* The list cannot rot quietly in the other direction either: a route that was
     public and has since been retired would otherwise sit here forever. */
  it("names only routes that still exist", () => {
    const live = new Set(routes.map(({ method, url }) => `${method} ${url}`));
    expect(
      PUBLIC.map((entry) => entry.route).filter((r) => !live.has(r)),
    ).toEqual([]);
  });
});
