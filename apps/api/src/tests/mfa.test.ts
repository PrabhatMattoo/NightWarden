import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationMember } from "@nightwarden/shared";
import { listAuditEvents } from "../audit/audit-store.js";
import { user } from "../auth/schema.js";
import { initEnv } from "../config/env.js";
import { getDb } from "../db.js";
import { createInvitation } from "../organization/organization-store.js";
import { harness, type Harness } from "./harness.js";
import {
  BROWSER_ORIGIN,
  call,
  cookieFrom,
  issueTestSession,
  ownerActor,
  sessionOf,
  TEST_MEMBER,
  TEST_OWNER,
} from "./session-helper.js";
import { refuseAuditWrites } from "./temp-db.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_MS = 30_000;

// RFC 6238 with the plugin's own parameters: SHA-1, six digits, thirty seconds.
function totpAt(uri: string, stepOffset = 0): string {
  const encoded = new URL(uri).searchParams.get("secret") ?? "";
  let bits = "";
  for (const char of encoded) {
    bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(
    BigInt(Math.floor(Date.now() / TOTP_STEP_MS) + stepOffset),
  );
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[19] ?? 0) & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

// A code outside the window the plugin accepts: one step back, now and one ahead.
function wrongCode(uri: string): string {
  const accepted = [-1, 0, 1].map((step) => totpAt(uri, step));
  return (
    ["000000", "111111", "222222"].find((c) => !accepted.includes(c)) ?? ""
  );
}

describe("multi-factor authentication", () => {
  let nw: Harness;
  let address: string;
  let nextAddress = 0;

  beforeEach(async () => {
    nw = await harness({ listen: false });
    // The rate limiter counts per address, and its memory outlives a test.
    address = `198.51.100.${++nextAddress}`;
  });

  afterEach(async () => {
    await nw.close();
    vi.unstubAllEnvs();
    initEnv();
  });

  const send = (
    method: Parameters<typeof call>[1],
    url: string,
    cookie: string | null,
    payload?: Record<string, unknown>,
  ) =>
    call(nw.server, method, url, cookie, payload, {
      remoteAddress: address,
      headers: { origin: BROWSER_ORIGIN },
    });

  const signIn = () =>
    send("POST", "/api/auth/sign-in/email", null, {
      email: TEST_MEMBER.email,
      password: TEST_MEMBER.password,
    });

  const verifyTotp = (cookie: string, code: string) =>
    send("POST", "/api/auth/two-factor/verify-totp", cookie, { code });

  // Any route behind the gate will do.
  const readOrganization = (cookie: string) =>
    send("GET", "/api/organization", cookie);

  const requireMfa = (required: boolean) =>
    send("PATCH", "/api/organization", nw.session, { requireMfa: required });

  // The admin whose story this is already has MFA; how it got there is another test's.
  const giveOwnerMfa = () =>
    getDb()
      .update(user)
      .set({ twoFactorEnabled: true })
      .where(eq(user.email, TEST_OWNER.email))
      .run();

  // The whole setup as the page runs it: the password, then a code from the authenticator.
  async function enrol(cookie: string) {
    const started = await send("POST", "/api/auth/two-factor/enable", cookie, {
      password: TEST_MEMBER.password,
    });
    expect(started.statusCode, started.body).toBe(200);
    const { totpURI } = JSON.parse(started.body) as { totpURI: string };
    const verified = await verifyTotp(cookie, totpAt(totpURI));
    expect(verified.statusCode, verified.body).toBe(200);
    // The finished setup replaces the session it began in.
    return { uri: totpURI, cookie: cookieFrom(verified) };
  }

  // Signs in with the password alone and reaches the code step.
  async function challenged() {
    const res = await signIn();
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ twoFactorRedirect: true });
    return cookieFrom(res);
  }

  async function memberRow() {
    const res = await send("GET", "/api/organization/members", nw.session);
    return (JSON.parse(res.body) as OrganizationMember[]).find(
      (m) => m.email === TEST_MEMBER.email,
    );
  }

  // From the store, since a required MFA refuses the admin who reads the trail.
  function mfaAudit() {
    return listAuditEvents(50, 0)
      .events.reverse()
      .filter(({ action }) => action.startsWith("mfa_"))
      .map(({ action, actorEmail, details }) => ({
        action,
        actorEmail,
        details,
      }));
  }

  it("turns on only once a code from the authenticator verifies, under the organization's name", async () => {
    const member = await issueTestSession("member");

    const started = await send("POST", "/api/auth/two-factor/enable", member, {
      password: TEST_MEMBER.password,
      issuer: "Somebody Else",
    });
    const { totpURI } = JSON.parse(started.body) as { totpURI: string };
    expect(new URL(totpURI).searchParams.get("issuer")).toBe(
      "Test Organization",
    );
    // Pending: a password alone still signs in until a code has verified.
    expect(JSON.parse((await signIn()).body)).not.toHaveProperty(
      "twoFactorRedirect",
    );

    const right = await verifyTotp(member, totpAt(totpURI));
    expect(right.statusCode).toBe(200);
    expect(
      (await sessionOf(nw.server, cookieFrom(right)))?.user.twoFactorEnabled,
    ).toBe(true);
  });

  it("remembers no device, so the next sign-in asks for a code again even when trust was asked for", async () => {
    const { uri } = await enrol(await issueTestSession("member"));

    const done = await send(
      "POST",
      "/api/auth/two-factor/verify-totp",
      await challenged(),
      { code: totpAt(uri), trustDevice: true },
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(cookieFrom(done)).not.toContain("trust_device");
    // The next sign-in is challenged again, trust requested or not.
    expect(JSON.parse((await signIn()).body)).toMatchObject({
      twoFactorRedirect: true,
    });
  });

  it("locks the account after five wrong codes across challenges, even for the right one", async () => {
    const { uri } = await enrol(await issueTestSession("member"));

    for (const attempts of [3, 2]) {
      const challenge = await challenged();
      for (let attempt = 0; attempt < attempts; attempt++) {
        expect((await verifyTotp(challenge, wrongCode(uri))).statusCode).toBe(
          401,
        );
      }
    }

    const locked = await verifyTotp(await challenged(), totpAt(uri));
    expect(locked.statusCode).toBe(429);
    expect((await readOrganization(cookieFrom(locked))).statusCode).toBe(401);
  });

  it("refuses a member without MFA everywhere but Better Auth's own paths while it is required, and refuses its removal once set up", async () => {
    const member = await issueTestSession("member");
    giveOwnerMfa();
    expect((await requireMfa(true)).statusCode).toBe(200);

    const refused = await readOrganization(member);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ code: "mfa_required" });
    expect((await sessionOf(nw.server, member))?.mfaRequired).toBe(true);

    const { cookie } = await enrol(member);
    expect((await sessionOf(nw.server, cookie))?.mfaRequired).toBe(false);
    const organization = await readOrganization(cookie);
    expect(organization.statusCode).toBe(200);
    // Every person reads the requirement, so the page knows when to hide removal.
    expect(JSON.parse(organization.body)).toMatchObject({ requireMfa: true });

    const removal = await send("POST", "/api/auth/two-factor/disable", cookie, {
      password: TEST_MEMBER.password,
    });
    expect(removal.statusCode).toBe(403);
    expect((await sessionOf(nw.server, cookie))?.user.twoFactorEnabled).toBe(
      true,
    );
  });

  it("refuses the requirement from an admin without MFA, records a change, nothing for a save that changes nothing, and refuses one the environment sets", async () => {
    expect((await requireMfa(true)).statusCode).toBe(409);
    giveOwnerMfa();
    // Off is already the value, so the first save records nothing.
    expect((await requireMfa(false)).statusCode).toBe(200);
    expect((await requireMfa(true)).statusCode).toBe(200);
    expect(mfaAudit()).toEqual([
      {
        action: "mfa_requirement_changed",
        actorEmail: "owner@example.test",
        details: { required: true },
      },
    ]);

    vi.stubEnv("NIGHTWARDEN_REQUIRE_MFA", "false");
    initEnv();
    expect(JSON.parse((await readOrganization(nw.session)).body)).toMatchObject(
      { requireMfa: false, locked: { requireMfa: "NIGHTWARDEN_REQUIRE_MFA" } },
    );
    expect((await requireMfa(true)).statusCode).toBe(409);
  });

  it("lets an admin reset a member's MFA so a password alone signs in again, recording it in the same transaction", async () => {
    await enrol(await issueTestSession("member"));
    const before = await memberRow();
    expect(before?.mfaEnabled).toBe(true);
    const reset = () =>
      send(
        "POST",
        `/api/organization/members/${before?.id}/reset-mfa`,
        nw.session,
      );

    const lift = refuseAuditWrites();
    expect((await reset()).statusCode).toBe(500);
    expect((await memberRow())?.mfaEnabled).toBe(true);
    lift();

    expect((await reset()).statusCode).toBe(204);
    expect((await memberRow())?.mfaEnabled).toBe(false);
    const signedIn = await signIn();
    expect(JSON.parse(signedIn.body)).not.toHaveProperty("twoFactorRedirect");
    expect(mfaAudit()).toEqual([
      {
        action: "mfa_reset",
        actorEmail: "owner@example.test",
        details: { email: TEST_MEMBER.email },
      },
    ]);

    expect(
      (
        await send(
          "POST",
          "/api/organization/members/no-such-member/reset-mfa",
          nw.session,
        )
      ).statusCode,
    ).toBe(404);
    expect((await reset()).statusCode).toBe(409);

    // The old secret is gone with the flag, so setup can begin afresh.
    await enrol(cookieFrom(signedIn));
  });

  it("keeps a removed member's MFA, so coming back by invitation means signing in with a code and then joining", async () => {
    const { uri } = await enrol(await issueTestSession("member"));
    const removed = await send(
      "DELETE",
      `/api/organization/members/${(await memberRow())?.id}`,
      nw.session,
    );
    expect(removed.statusCode).toBe(204);
    const { token } = createInvitation(
      { email: TEST_MEMBER.email, role: "member", teamIds: [] },
      ownerActor(),
    );

    const challenge = await challenged();
    const signedIn = await verifyTotp(challenge, totpAt(uri));
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const accepted = await send(
      "POST",
      `/api/invitations/${token}/accept`,
      cookieFrom(signedIn),
      {},
    );

    expect(accepted.statusCode, accepted.body).toBe(204);
    expect(await memberRow()).toMatchObject({
      role: "member",
      mfaEnabled: true,
    });
  });
});
