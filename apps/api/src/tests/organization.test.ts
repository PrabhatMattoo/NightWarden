import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuditPage,
  InvitationPreview,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationTeam,
  RoleName,
} from "@nightwarden/shared";
import { createAccount } from "../auth/accounts.js";
import { initEnv } from "../config/env.js";
import { getDb } from "../db.js";
import {
  acceptInvitation,
  addMember,
  AlreadyMemberError,
  cancelInvitation,
  createInvitation,
  InvitationNotValidError,
} from "../organization/organization-store.js";
import { invitation } from "../organization/schema.js";
import { hashToken } from "../secrets.js";
import { harness, type Harness } from "./harness.js";
import {
  accountId,
  call,
  cookieFrom,
  ownerActor,
  seedChatSession,
  sessionOf,
  signIn,
} from "./session-helper.js";
import { decodeBody, useSmtpServer } from "./smtp-helper.js";

const smtp = useSmtpServer();

const PASSWORD = "a-long-enough-password";

describe("the organization's people", () => {
  let nw: Harness;

  beforeEach(async () => {
    smtp.delivered.length = 0;
    nw = await harness({ listen: false });
  });

  afterEach(async () => {
    await nw.close();
    vi.unstubAllEnvs();
    initEnv();
  });

  const anonymously = (
    method: Parameters<typeof call>[1],
    url: string,
    payload?: Record<string, unknown>,
  ) => call(nw.server, method, url, null, payload);

  async function configureMail(): Promise<void> {
    const saved = await nw.asAdmin("PUT", "/api/config/mail", smtp.settings());
    expect(saved.statusCode).toBe(200);
  }

  // The token in the link of the newest email, which is the invitation's only credential.
  function linkedToken(): string {
    const message = decodeBody(smtp.delivered.at(-1) ?? "");
    const token = message.match(/\/invite\/(nwv_[\w-]+)/)?.[1];
    if (token === undefined)
      throw new Error("the email carries no invite link");
    return token;
  }

  async function invite(
    email: string,
    role: RoleName,
    teamIds?: string[],
  ): Promise<string> {
    const res = await nw.asAdmin("POST", "/api/organization/invitations", {
      email,
      role,
      ...(teamIds !== undefined && { teamIds }),
    });
    expect(res.statusCode, res.body).toBe(204);
    return linkedToken();
  }

  const accept = (token: string, body: Record<string, unknown>) =>
    anonymously("POST", `/api/invitations/${token}/accept`, body);

  // A new colleague through the whole flow: invited, emailed, and accepted.
  async function join(email: string, role: RoleName): Promise<string> {
    const token = await invite(email, role);
    const res = await accept(token, { name: email, password: PASSWORD });
    expect(res.statusCode, res.body).toBe(204);
    return cookieFrom(res);
  }

  const members = () =>
    nw.readAsAdmin<OrganizationMember[]>("/api/organization/members");

  async function memberOf(email: string): Promise<OrganizationMember> {
    const found = (await members()).find((m) => m.email === email);
    if (found === undefined) throw new Error(`${email} is not a member`);
    return found;
  }

  const pendingInvitations = () =>
    nw.readAsAdmin<OrganizationInvitation[]>("/api/organization/invitations");

  const teams = () =>
    nw.readAsAdmin<OrganizationTeam[]>("/api/organization/teams");

  // Oldest first, after the two rows setup writes: the organization and its default team.
  async function audit() {
    const res = await nw.asAdmin("GET", "/api/audit");
    const { events } = JSON.parse(res.body) as AuditPage;
    return events
      .reverse()
      .slice(2)
      .map((event) => ({
        action: event.action,
        actorEmail: event.actorEmail,
        details: event.details,
      }));
  }

  async function preview(token: string) {
    const res = await anonymously("GET", `/api/invitations/${token}`);
    return { status: res.statusCode, body: res.body };
  }

  it("refuses an invitation while no mail server is set", async () => {
    const res = await nw.asAdmin("POST", "/api/organization/invitations", {
      email: "new@example.test",
      role: "member",
    });

    expect(res.statusCode).toBe(409);
    expect(await pendingInvitations()).toEqual([]);
  });

  it("emails a link whose page previews the invitation and whose acceptance makes a signed-in account with the invited role", async () => {
    await configureMail();
    const token = await invite("new@example.test", "viewer");

    // Only the hash is stored, so a copy of the database cannot accept an invitation.
    const stored = getDb().select().from(invitation).all();
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored).toMatchObject([{ tokenHash: hashToken(token) }]);

    const shown = await preview(token);
    expect(shown.status).toBe(200);
    expect(JSON.parse(shown.body) as InvitationPreview).toEqual({
      email: "new@example.test",
      organizationName: "Test Organization",
      role: "viewer",
      inviterName: "Owner",
      accountExists: false,
      expired: false,
    });

    const accepted = await accept(token, { name: "New", password: PASSWORD });
    expect(accepted.statusCode).toBe(204);
    const cookie = cookieFrom(accepted);
    expect((await sessionOf(nw.server, cookie))?.role).toBe("viewer");
    expect(
      (await call(nw.server, "GET", "/api/organization", cookie)).statusCode,
    ).toBe(200);
    expect(
      (await call(nw.server, "GET", "/api/config", cookie)).statusCode,
    ).toBe(403);
    expect(await memberOf("new@example.test")).toMatchObject({
      name: "New",
      role: "viewer",
    });
    expect(await pendingInvitations()).toEqual([]);
    expect(await audit()).toEqual([
      {
        action: "member_invited",
        actorEmail: "owner@example.test",
        details: { email: "new@example.test", role: "viewer" },
      },
      {
        action: "member_joined",
        actorEmail: "new@example.test",
        details: { email: "new@example.test", role: "viewer" },
      },
    ]);

    // The link is spent: it neither previews nor accepts a second time.
    expect((await preview(token)).status).toBe(404);
    expect(
      (await accept(token, { name: "New", password: PASSWORD })).statusCode,
    ).toBe(404);
  });

  it("refuses an invitation that was canceled, expired or never issued", async () => {
    await configureMail();
    const canceled = await invite("canceled@example.test", "member");
    const [pending] = await pendingInvitations();
    const res = await nw.asAdmin(
      "DELETE",
      `/api/organization/invitations/${pending?.id}`,
    );
    expect(res.statusCode).toBe(204);

    expect((await preview(canceled)).status).toBe(404);
    expect(
      (await accept(canceled, { name: "No", password: PASSWORD })).statusCode,
    ).toBe(404);
    expect(
      (await accept(`nwv_${randomUUID()}`, { name: "No", password: PASSWORD }))
        .statusCode,
    ).toBe(404);

    const stale = await invite("stale@example.test", "member");
    getDb()
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(invitation.tokenHash, hashToken(stale)))
      .run();
    expect(JSON.parse((await preview(stale)).body)).toMatchObject({
      expired: true,
    });
    expect(
      (await accept(stale, { name: "No", password: PASSWORD })).statusCode,
    ).toBe(410);

    expect(await members()).toHaveLength(1);
    expect((await audit()).map((event) => event.action)).toContain(
      "invitation_canceled",
    );
  });

  it("replaces a pending invitation when the same email is invited again", async () => {
    await configureMail();
    const first = await invite("twice@example.test", "member");
    const second = await invite("twice@example.test", "viewer");

    expect(await pendingInvitations()).toMatchObject([{ role: "viewer" }]);
    expect((await preview(first)).status).toBe(404);
    expect((await preview(second)).status).toBe(200);
    expect((await audit()).map((event) => event.action)).toEqual([
      "member_invited",
      "invitation_canceled",
      "member_invited",
    ]);
  });

  it("asks a person with no account for a name and creates nothing without one", async () => {
    await configureMail();
    const token = await invite("nameless@example.test", "member");

    const res = await accept(token, { password: PASSWORD });

    expect(res.statusCode).toBe(400);
    expect((await preview(token)).status).toBe(200);
    expect(await members()).toHaveLength(1);
  });

  it("ends a removed member's sessions at once and refuses everything to a later sign-in", async () => {
    await configureMail();
    const cookie = await join("leaver@example.test", "member");
    expect(
      (await call(nw.server, "GET", "/api/organization", cookie)).statusCode,
    ).toBe(200);
    const leaver = await memberOf("leaver@example.test");

    const removed = await nw.asAdmin(
      "DELETE",
      `/api/organization/members/${leaver.id}`,
    );
    expect(removed.statusCode).toBe(204);

    // Signed out: the row is gone, so the cookie is a stranger's.
    expect(
      (await call(nw.server, "GET", "/api/sessions", cookie)).statusCode,
    ).toBe(401);
    // The account itself survives and can sign in, but belongs to nothing.
    const again = await signIn(nw.server, {
      email: "leaver@example.test",
      password: PASSWORD,
    });
    expect(again.statusCode).toBe(200);
    const fresh = cookieFrom(again);
    const refused = await call(nw.server, "GET", "/api/sessions", fresh);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({
      error: "This account is no longer a member of the organization.",
      code: "not_a_member",
    });
    expect((await sessionOf(nw.server, fresh))?.role).toBeNull();
    expect((await members()).map((m) => m.email)).not.toContain(
      "leaver@example.test",
    );
    expect((await audit()).at(-1)).toMatchObject({
      action: "member_removed",
      actorEmail: "owner@example.test",
      details: { email: "leaver@example.test", role: "member" },
    });
  });

  it("restores a removed member's access and chats when they accept a new invitation signed in as themselves", async () => {
    await configureMail();
    await join("back@example.test", "member");
    const userId = accountId("back@example.test");
    const chat = randomUUID();
    seedChatSession(chat, "mine", userId);
    const before = await memberOf("back@example.test");
    await nw.asAdmin("DELETE", `/api/organization/members/${before.id}`);

    const token = await invite("back@example.test", "viewer");
    expect(JSON.parse((await preview(token)).body)).toMatchObject({
      accountExists: true,
    });
    const acceptAs = (cookie: string | null) =>
      call(nw.server, "POST", `/api/invitations/${token}/accept`, cookie, {});

    // Signing in belongs to the sign-in page, so nobody, and nobody else, can accept for the account.
    expect((await acceptAs(null)).statusCode).toBe(401);
    expect((await acceptAs(nw.session)).statusCode).toBe(403);
    expect((await members()).map((m) => m.email)).not.toContain(
      "back@example.test",
    );

    const cookie = cookieFrom(
      await signIn(nw.server, {
        email: "back@example.test",
        password: PASSWORD,
      }),
    );
    expect((await acceptAs(cookie)).statusCode).toBe(204);
    expect(await memberOf("back@example.test")).toMatchObject({
      userId,
      role: "viewer",
    });
    expect(
      (await call(nw.server, "GET", `/api/sessions/${chat}`, cookie))
        .statusCode,
    ).toBe(200);
  });

  it("records a role change", async () => {
    await configureMail();
    const cookie = await join("riser@example.test", "member");
    const riser = await memberOf("riser@example.test");

    const changed = await nw.asAdmin(
      "PATCH",
      `/api/organization/members/${riser.id}`,
      { role: "admin" },
    );
    expect(changed.statusCode).toBe(204);
    // Naming the role it already has records nothing.
    await nw.asAdmin("PATCH", `/api/organization/members/${riser.id}`, {
      role: "admin",
    });
    // The role is read at each request, so the open session gains it.
    expect(
      (await call(nw.server, "GET", "/api/config", cookie)).statusCode,
    ).toBe(200);
    expect(
      (await audit()).filter((event) => event.action === "member_role_changed"),
    ).toEqual([
      {
        action: "member_role_changed",
        actorEmail: "owner@example.test",
        details: {
          email: "riser@example.test",
          role: "admin",
          previousRole: "member",
        },
      },
    ]);
  });

  it("refuses to demote or remove the last admin, and allows it once another exists", async () => {
    const owner = await memberOf("owner@example.test");
    const demote = (id: string, cookie: string) =>
      call(nw.server, "PATCH", `/api/organization/members/${id}`, cookie, {
        role: "member",
      });

    expect((await demote(owner.id, nw.session)).statusCode).toBe(409);
    expect(
      (await nw.asAdmin("DELETE", `/api/organization/members/${owner.id}`))
        .statusCode,
    ).toBe(409);
    expect(await memberOf("owner@example.test")).toMatchObject({
      role: "admin",
    });

    await configureMail();
    const second = await join("second@example.test", "admin");
    const secondAdmin = await memberOf("second@example.test");
    expect((await demote(owner.id, nw.session)).statusCode).toBe(204);
    // The second admin is now the last one.
    expect((await demote(secondAdmin.id, second)).statusCode).toBe(409);
  });

  /* The route checks the token first; the store checks again inside the transaction,
     which is what holds when a cancellation or an expiry lands during the sign-in. */
  it("accepts only a pending, unexpired invitation, and only for the account that owns the invited address", async () => {
    const owner = ownerActor();
    const invited = createInvitation(
      { email: "invited@example.test", role: "admin", teamIds: [] },
      owner,
    );
    const withdrawn = createInvitation(
      { email: "withdrawn@example.test", role: "admin", teamIds: [] },
      owner,
    );
    cancelInvitation(withdrawn.id, owner);
    const lapsed = createInvitation(
      { email: "lapsed@example.test", role: "admin", teamIds: [] },
      owner,
    );
    getDb()
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(invitation.id, lapsed.id))
      .run();
    const account = (email: string) =>
      createAccount({ name: email, email, password: PASSWORD });

    const attempts = [
      [withdrawn.id, await account("withdrawn@example.test")],
      [lapsed.id, await account("lapsed@example.test")],
      [invited.id, await account("other@example.test")],
    ] as const;
    for (const [invitationId, userId] of attempts) {
      expect(() => acceptInvitation(invitationId, userId)).toThrow(
        InvitationNotValidError,
      );
    }

    expect((await members()).map((m) => m.email)).toEqual([
      "owner@example.test",
    ]);
    expect(await pendingInvitations()).toHaveLength(1);
  });

  it("refuses to invite or add someone who is already a member", async () => {
    await configureMail();
    await join("member@example.test", "member");

    const res = await nw.asAdmin("POST", "/api/organization/invitations", {
      email: "member@example.test",
      role: "viewer",
    });

    expect(res.statusCode).toBe(409);
    expect(() =>
      addMember(accountId("member@example.test"), "viewer", ownerActor()),
    ).toThrow(AlreadyMemberError);
    expect(await memberOf("member@example.test")).toMatchObject({
      role: "member",
    });
  });

  it("tells the inviting admin when the email cannot be sent and leaves no invitation behind", async () => {
    await configureMail();
    // The environment outranks the stored setting, so the next send meets a closed port.
    vi.stubEnv("NIGHTWARDEN_SMTP_PORT", "1");
    initEnv();

    const res = await nw.asAdmin("POST", "/api/organization/invitations", {
      email: "unreachable@example.test",
      role: "member",
    });

    expect(res.statusCode).toBe(502);
    expect(await pendingInvitations()).toEqual([]);
    expect((await audit()).map((event) => event.action)).toEqual([
      "member_invited",
      "invitation_canceled",
    ]);
  });

  it("keeps teams: the default one setup made, and others created, joined by invitation or by an admin, left, renamed and deleted", async () => {
    await configureMail();
    const [byDefault] = await teams();
    expect(byDefault).toMatchObject({
      name: "Test Organization",
      isDefault: true,
      memberCount: 1,
    });
    expect(
      (await nw.asAdmin("DELETE", `/api/organization/teams/${byDefault?.id}`))
        .statusCode,
    ).toBe(409);

    const created = await nw.asAdmin("POST", "/api/organization/teams", {
      name: "Platform",
    });
    expect(created.statusCode).toBe(200);
    const { id: teamId } = JSON.parse(created.body) as { id: string };

    // A team that does not exist sends nothing and leaves nothing pending.
    const unknownTeam = await nw.asAdmin(
      "POST",
      "/api/organization/invitations",
      {
        email: "ghost@example.test",
        role: "member",
        teamIds: [teamId, randomUUID()],
      },
    );
    expect(unknownTeam.statusCode).toBe(404);
    expect(await pendingInvitations()).toEqual([]);
    expect(smtp.delivered).toEqual([]);

    await join("joiner@example.test", "member");
    const viaInvite = await invite("teamed@example.test", "member", [teamId]);
    await accept(viaInvite, { name: "Teamed", password: PASSWORD });
    expect((await memberOf("teamed@example.test")).teams).toEqual([
      { id: teamId, name: "Platform" },
    ]);

    const joiner = await memberOf("joiner@example.test");
    const add = () =>
      nw.asAdmin("POST", `/api/organization/teams/${teamId}/members`, {
        userId: joiner.userId,
      });
    const leave = () =>
      nw.asAdmin(
        "DELETE",
        `/api/organization/teams/${teamId}/members/${joiner.userId}`,
      );
    expect([(await add()).statusCode, (await add()).statusCode]).toEqual([
      204, 204,
    ]);
    expect((await teams()).find((t) => t.id === teamId)).toMatchObject({
      name: "Platform",
      memberCount: 2,
    });
    const stranger = await nw.asAdmin(
      "POST",
      `/api/organization/teams/${teamId}/members`,
      { userId: randomUUID() },
    );
    expect(stranger.statusCode).toBe(404);

    expect([(await leave()).statusCode, (await leave()).statusCode]).toEqual([
      204, 204,
    ]);
    expect((await teams()).find((t) => t.id === teamId)).toMatchObject({
      memberCount: 1,
    });

    await nw.asAdmin("PATCH", `/api/organization/teams/${teamId}`, {
      name: "Reliability",
    });
    await nw.asAdmin("DELETE", `/api/organization/teams/${teamId}`);
    expect((await teams()).map((t) => t.id)).toEqual([byDefault?.id]);
    expect((await memberOf("teamed@example.test")).teams).toEqual([]);

    // Doing either twice changed nothing the second time, so it recorded nothing.
    expect(
      (await audit())
        .filter((event) => event.action.startsWith("team_"))
        .map((event) => [event.action, event.details]),
    ).toEqual([
      ["team_created", { name: "Platform" }],
      ["team_member_added", { email: "joiner@example.test", team: "Platform" }],
      [
        "team_member_removed",
        { email: "joiner@example.test", team: "Platform" },
      ],
      ["team_renamed", { name: "Reliability", previousName: "Platform" }],
      ["team_deleted", { name: "Reliability" }],
    ]);
  });

  it("lets any member read the organization's name and only an admin change it, refusing a logo that is not a small inline image", async () => {
    await configureMail();
    const cookie = await join("reader@example.test", "viewer");
    expect(
      JSON.parse(
        (await call(nw.server, "GET", "/api/organization", cookie)).body,
      ),
    ).toEqual({ name: "Test Organization", logo: null });

    const logo = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4";
    expect(
      (
        await nw.asAdmin("PATCH", "/api/organization", {
          name: "  Renamed  ",
          logo,
        })
      ).statusCode,
    ).toBe(200);
    // The name it already has changes nothing and records nothing.
    await nw.asAdmin("PATCH", "/api/organization", { name: "Renamed" });
    expect(
      (
        await nw.asAdmin("PATCH", "/api/organization", {
          logo: "https://example.test/logo.png",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      JSON.parse(
        (await call(nw.server, "GET", "/api/organization", cookie)).body,
      ),
    ).toEqual({ name: "Renamed", logo });
    expect(
      (await audit()).filter((event) =>
        event.action.startsWith("organization"),
      ),
    ).toEqual([
      {
        action: "organization_updated",
        actorEmail: "owner@example.test",
        details: { fields: ["name", "logo"] },
      },
    ]);
  });
});
