import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationTeam,
} from "@nightwarden/shared";
import { userIdByEmail } from "../auth/account-store.js";
import { user } from "../auth/schema.js";
import { getDb } from "../db.js";
import { createInvitation } from "../organization/organization-store.js";
import { member, organization } from "../organization/schema.js";
import { prepareSetup } from "../organization/setup-token.js";
import { setupTokenPath } from "../paths.js";
import { buildServer } from "../server.js";
import { harness, type Harness } from "./harness.js";
import {
  call,
  issueTestSession,
  ownerActor,
  TEST_MEMBER,
} from "./session-helper.js";
import { useSmtpServer } from "./smtp-helper.js";
import { refuseAuditWrites, useTempDb } from "./temp-db.js";

const smtp = useSmtpServer();

const PASSWORD = "a-long-enough-password";

/* An organization change and its audit row are one transaction, so a change whose
   audit write fails must not land. Each case makes the next audit insert fail. */
describe("an organization change and its audit row", () => {
  let nw: Harness;

  beforeEach(async () => {
    nw = await harness({ listen: false });
  });

  afterEach(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  // The default team setup made is not part of what these cases change.
  const madeTeams = async () =>
    (await nw.readAsAdmin<OrganizationTeam[]>("/api/organization/teams"))
      .filter((t) => !t.isDefault)
      .map(({ id, name, memberCount }) => ({ id, name, memberCount }));

  it("keeps a member's role and sessions when the change cannot be recorded", async () => {
    const cookie = await issueTestSession("member");
    const members = await nw.readAsAdmin<OrganizationMember[]>(
      "/api/organization/members",
    );
    const target = members.find((m) => m.email === TEST_MEMBER.email);
    refuseAuditWrites();

    const promoted = await nw.asAdmin(
      "PATCH",
      `/api/organization/members/${target?.id}`,
      { role: "admin" },
    );
    const removed = await nw.asAdmin(
      "DELETE",
      `/api/organization/members/${target?.id}`,
    );

    expect([promoted.statusCode, removed.statusCode]).toEqual([500, 500]);
    expect(
      (
        await nw.readAsAdmin<OrganizationMember[]>("/api/organization/members")
      ).find((m) => m.email === TEST_MEMBER.email),
    ).toMatchObject({ role: "member" });
    // The removal also ends sessions, and that rolled back with the rest.
    expect(
      (await call(nw.server, "GET", "/api/organization", cookie)).statusCode,
    ).toBe(200);
  });

  it("leaves an invitation as it was when its creation, acceptance or cancellation cannot be recorded", async () => {
    smtp.delivered.length = 0;
    expect(
      (await nw.asAdmin("PUT", "/api/config/mail", smtp.settings())).statusCode,
    ).toBe(200);
    const lift = refuseAuditWrites();

    const invited = await nw.asAdmin("POST", "/api/organization/invitations", {
      email: "new@example.test",
      role: "member",
    });
    expect(invited.statusCode).toBe(500);
    expect(
      await nw.readAsAdmin<OrganizationInvitation[]>(
        "/api/organization/invitations",
      ),
    ).toEqual([]);
    expect(smtp.delivered).toEqual([]);
    lift();

    const { token } = createInvitation(
      { email: "later@example.test", role: "member", teamIds: [] },
      ownerActor(),
    );
    refuseAuditWrites();
    const accepted = await call(
      nw.server,
      "POST",
      `/api/invitations/${token}/accept`,
      null,
      { name: "Later", password: PASSWORD },
    );
    const [pending] = await nw.readAsAdmin<OrganizationInvitation[]>(
      "/api/organization/invitations",
    );
    const canceled = await nw.asAdmin(
      "DELETE",
      `/api/organization/invitations/${pending?.id}`,
    );

    expect([accepted.statusCode, canceled.statusCode]).toEqual([500, 500]);
    expect(
      (await call(nw.server, "GET", `/api/invitations/${token}`, null))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await nw.readAsAdmin<OrganizationMember[]>("/api/organization/members")
      ).map((m) => m.email),
    ).not.toContain("later@example.test");
    // The account made for the invitation went with the failed acceptance.
    expect(userIdByEmail("later@example.test")).toBeUndefined();
  });

  it("leaves teams as they were when a change cannot be recorded", async () => {
    const refusedCreate = refuseAuditWrites();
    const created = await nw.asAdmin("POST", "/api/organization/teams", {
      name: "Platform",
    });
    expect(created.statusCode).toBe(500);
    expect(await madeTeams()).toEqual([]);
    refusedCreate();

    const { id } = JSON.parse(
      (
        await nw.asAdmin("POST", "/api/organization/teams", {
          name: "Platform",
        })
      ).body,
    ) as { id: string };
    await issueTestSession("member");
    const colleague = (
      await nw.readAsAdmin<OrganizationMember[]>("/api/organization/members")
    ).find((m) => m.email === TEST_MEMBER.email);
    refuseAuditWrites();

    const results = await Promise.all([
      nw.asAdmin("PATCH", `/api/organization/teams/${id}`, { name: "Renamed" }),
      nw.asAdmin("POST", `/api/organization/teams/${id}/members`, {
        userId: colleague?.userId,
      }),
      nw.asAdmin("DELETE", `/api/organization/teams/${id}`),
    ]);

    expect(results.map((res) => res.statusCode)).toEqual([500, 500, 500]);
    expect(await madeTeams()).toEqual([
      { id, name: "Platform", memberCount: 0 },
    ]);
  });

  it("keeps the organization's name when the change cannot be recorded", async () => {
    refuseAuditWrites();

    const res = await nw.asAdmin("PATCH", "/api/organization", {
      name: "Renamed",
    });

    expect(res.statusCode).toBe(500);
    expect(
      JSON.parse((await nw.asAdmin("GET", "/api/organization")).body),
    ).toMatchObject({ name: "Test Organization" });
  });
});

describe("setup and its audit row", () => {
  let cleanupDb: () => void;

  beforeEach(() => {
    cleanupDb = useTempDb();
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("leaves no account, no organization and a usable token when the first audit row cannot be written", async () => {
    prepareSetup();
    const token = readFileSync(setupTokenPath(), "utf8");
    const { server } = await buildServer();
    await server.ready();
    refuseAuditWrites();

    const res = await server.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        token,
        organizationName: "Acme Ops",
        name: "Admin",
        email: "admin@example.com",
        password: "correcthorsebattery",
      },
    });
    await server.close();

    expect(res.statusCode).toBe(500);
    expect(getDb().select().from(user).all()).toEqual([]);
    expect(getDb().select().from(organization).all()).toEqual([]);
    expect(getDb().select().from(member).all()).toEqual([]);
    // Written back, so the owner can try again.
    expect(existsSync(setupTokenPath())).toBe(true);
    expect(readFileSync(setupTokenPath(), "utf8")).toBe(token);
  });
});
