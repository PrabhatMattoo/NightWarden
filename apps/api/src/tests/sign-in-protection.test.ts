import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTempDb } from "./temp-db.js";
import { issueTestSession, TEST_MEMBER, TEST_OWNER } from "./session-helper.js";
import { CLIENT_IP_HEADER } from "../auth/instance.js";
import { buildServer } from "../server.js";

// The per-address guard allows 60 sign-in requests a minute.
const FLOOD_LIMIT = 60;
const WRONG_PASSWORD = "not-the-password-at-all";

describe("sign-in protection", () => {
  let cleanupDb: () => void;
  let server: FastifyInstance;

  beforeEach(async () => {
    cleanupDb = useTempDb();
    await issueTestSession("member");
  });

  afterEach(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  async function start(trustProxy?: string[]): Promise<void> {
    ({ server } = await buildServer({
      ...(trustProxy !== undefined && { trustProxy }),
    }));
    await server.ready();
  }

  function signIn(
    remoteAddress: string,
    body: { email: string; password?: string },
    headers: Record<string, string> = {},
  ) {
    return server.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress,
      // What a browser puts on a POST; inject dials localhost, the trusted origin.
      headers: { origin: "http://localhost", ...headers },
      payload: body,
    });
  }

  // A different address each call, which is what a distributed guesser looks like.
  const addressFor = (attempt: number) => `198.51.100.${attempt + 1}`;

  const wrong = (attempt: number) =>
    signIn(addressFor(attempt), {
      email: TEST_OWNER.email,
      password: WRONG_PASSWORD,
    });

  const right = (remoteAddress: string, account = TEST_OWNER) =>
    signIn(remoteAddress, {
      email: account.email,
      password: account.password,
    });

  // No password, so Better Auth refuses before it hashes; the limiter still counts it.
  async function floodStatuses(
    remoteAddress: string,
    headersFor: (attempt: number) => Record<string, string>,
  ): Promise<number[]> {
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= FLOOD_LIMIT; attempt++) {
      const res = await signIn(
        remoteAddress,
        { email: `guess-${attempt}@example.com` },
        headersFor(attempt),
      );
      statuses.push(res.statusCode);
    }
    return statuses;
  }

  it("refuses an account after five wrong passwords from any addresses, whatever password comes next", async () => {
    await start();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await wrong(attempt)).statusCode).toBe(401);
    }

    const locked = await right(addressFor(5));
    expect(locked.statusCode).toBe(429);
    const retryAfterS = Number(locked.headers["retry-after"]);
    expect(retryAfterS).toBeGreaterThanOrEqual(1);
    expect(retryAfterS).toBeLessThanOrEqual(15 * 60);

    expect((await right(addressFor(6), TEST_MEMBER)).statusCode).toBe(200);
  });

  it("forgives the failures once the right password signs in", async () => {
    await start();
    for (let attempt = 0; attempt < 4; attempt++) await wrong(attempt);
    expect((await right(addressFor(4))).statusCode).toBe(200);

    for (let attempt = 5; attempt < 10; attempt++) {
      expect((await wrong(attempt)).statusCode).toBe(401);
    }
    expect((await wrong(10)).statusCode).toBe(429);
  });

  it("ignores a client-IP header the visitor sends, so one address cannot dodge the flood guard", async () => {
    await start();
    const statuses = await floodStatuses("203.0.113.9", (attempt) => ({
      [CLIENT_IP_HEADER]: `192.0.2.${attempt + 1}`,
    }));

    expect(statuses[FLOOD_LIMIT - 1]).not.toBe(429);
    expect(statuses[FLOOD_LIMIT]).toBe(429);
  });

  it("believes X-Forwarded-For from a trusted proxy and not from anyone else", async () => {
    await start(["10.0.0.1"]);
    const forwarded = (attempt: number) => ({
      "x-forwarded-for": `192.0.2.${attempt + 1}`,
    });

    const viaProxy = await floodStatuses("10.0.0.1", forwarded);
    expect(viaProxy).not.toContain(429);

    const direct = await floodStatuses("10.0.0.2", forwarded);
    expect(direct[FLOOD_LIMIT - 1]).not.toBe(429);
    expect(direct[FLOOD_LIMIT]).toBe(429);
  });
});
