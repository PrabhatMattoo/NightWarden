// Every audited write is one transaction that also writes its audit row, so neither lands alone.
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
import {
  ADMIN_ROLE,
  type Actor,
  type InvitationPreview,
  type Organization,
  type OrganizationInvitation,
  type OrganizationMember,
  type OrganizationTeam,
  type RoleName,
} from "@nightwarden/shared";
import { recordAuditEvent } from "../audit/audit-store.js";
import { deleteSessionsOf } from "../auth/account-store.js";
import { user } from "../auth/schema.js";
import { envConfig, refuseLocked } from "../config/env.js";
import { type Db, getDb } from "../db.js";
import { INVITATION_LIFETIME_S } from "../mail/messages.js";
import { hashToken, issueToken, tokenMatches } from "../secrets.js";
import {
  invitation,
  invitationTeam,
  member,
  organization,
  team,
  teamMember,
} from "./schema.js";

export class NotFoundError extends Error {}

export class LastAdminError extends Error {
  constructor() {
    super("The organization needs at least one admin.");
  }
}

export class AlreadyMemberError extends Error {
  constructor() {
    super("This account is already a member of the organization.");
  }
}

// Requiring MFA without having it would shut its own admin out behind the setup page.
export class OwnMfaRequiredError extends Error {
  constructor() {
    super("Set up your own MFA before requiring it of everyone.");
  }
}

export class DefaultTeamError extends Error {
  constructor() {
    super("The default team cannot be deleted.");
  }
}

export class InvitationNotValidError extends Error {
  constructor() {
    super("This invitation is not valid.");
  }
}

export interface OrganizationPatch {
  name?: string | undefined;
  logo?: string | null | undefined;
  requireMfa?: boolean | undefined;
}

export type PendingInvitation = Omit<InvitationPreview, "accountExists"> & {
  id: string;
};

const nowIso = (): string => new Date().toISOString();

// The environment's answer when it sets one, else the organization's own.
function effectiveRequireMfa(stored: boolean): boolean {
  return envConfig().organization.requireMfa ?? stored;
}

function organizationOf(row: {
  name: string;
  logo: string | null;
  requireMfa: boolean;
}): Organization {
  return {
    name: row.name,
    logo: row.logo,
    requireMfa: effectiveRequireMfa(row.requireMfa),
    locked: envConfig().locked.organization,
  };
}

function organizationIn(db: Db): { id: string; name: string } {
  const found = db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .get();
  if (found === undefined) throw new NotFoundError("unknown organization");
  return found;
}

function memberIn(db: Db, memberId: string) {
  const found = db
    .select({
      userId: member.userId,
      role: member.role,
      email: user.email,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.id, memberId))
    .get();
  if (found === undefined) throw new NotFoundError("unknown member");
  return found;
}

function teamIn(db: Db, teamId: string) {
  const found = db
    .select({ id: team.id, name: team.name, isDefault: team.isDefault })
    .from(team)
    .where(eq(team.id, teamId))
    .get();
  if (found === undefined) throw new NotFoundError("unknown team");
  return found;
}

// Demoting and removing share this guard, so neither can leave the install with no admin.
function refuseLastAdmin(db: Db, target: { role: RoleName }): void {
  if (target.role !== ADMIN_ROLE) return;
  const admins =
    db
      .select({ admins: count() })
      .from(member)
      .where(eq(member.role, ADMIN_ROLE))
      .get()?.admins ?? 0;
  if (admins <= 1) throw new LastAdminError();
}

function insertMember(
  db: Db,
  organizationId: string,
  userId: string,
  role: RoleName,
): void {
  db.insert(member)
    .values({
      id: randomUUID(),
      organizationId,
      userId,
      role,
      createdAt: nowIso(),
    })
    .run();
}

export function createOrganization(
  name: string,
  ownerUserId: string,
  actor: Actor,
): void {
  getDb().transaction((tx) => {
    if (tx.select({ id: organization.id }).from(organization).get()) {
      throw new Error("This install already has an organization.");
    }
    const id = randomUUID();
    const teamId = randomUUID();
    const createdAt = nowIso();
    tx.insert(organization).values({ id, name, createdAt }).run();
    insertMember(tx, id, ownerUserId, ADMIN_ROLE);
    tx.insert(team)
      .values({
        id: teamId,
        organizationId: id,
        name,
        isDefault: true,
        createdAt,
      })
      .run();
    tx.insert(teamMember)
      .values({ teamId, userId: ownerUserId, createdAt })
      .run();
    recordAuditEvent(
      {
        actor,
        action: "organization_created",
        target: null,
        details: { name },
        sessionId: null,
      },
      tx,
    );
    recordAuditEvent(
      {
        actor,
        action: "team_created",
        target: teamId,
        details: { name },
        sessionId: null,
      },
      tx,
    );
  });
}

export function updateOrganization(
  patch: OrganizationPatch,
  actor: Actor,
): Organization {
  refuseLocked(envConfig().locked.organization, patch);
  return getDb().transaction((tx) => {
    const current = tx.select().from(organization).get();
    if (current === undefined) throw new NotFoundError("unknown organization");
    const fields: ("name" | "logo")[] = [];
    if (patch.name !== undefined && patch.name !== current.name) {
      fields.push("name");
    }
    if (patch.logo !== undefined && patch.logo !== current.logo) {
      fields.push("logo");
    }
    const mfaChanged =
      patch.requireMfa !== undefined && patch.requireMfa !== current.requireMfa;
    if (mfaChanged && patch.requireMfa === true) {
      const own = tx
        .select({ enabled: user.twoFactorEnabled })
        .from(user)
        .where(eq(user.id, actor.id))
        .get();
      if (own?.enabled !== true) throw new OwnMfaRequiredError();
    }
    if (fields.length === 0 && !mfaChanged) return organizationOf(current);
    const updated = tx
      .update(organization)
      .set({
        name: patch.name,
        logo: patch.logo,
        requireMfa: patch.requireMfa,
      })
      .where(eq(organization.id, current.id))
      .returning()
      .get();
    if (fields.length > 0) {
      recordAuditEvent(
        {
          actor,
          action: "organization_updated",
          target: null,
          details: { fields },
          sessionId: null,
        },
        tx,
      );
    }
    if (mfaChanged) {
      recordAuditEvent(
        {
          actor,
          action: "mfa_requirement_changed",
          target: null,
          details: { required: updated.requireMfa },
          sessionId: null,
        },
        tx,
      );
    }
    return organizationOf(updated);
  });
}

export function addMember(userId: string, role: RoleName, actor: Actor): void {
  getDb().transaction((tx) => {
    const account = tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    if (account === undefined) throw new NotFoundError("unknown account");
    const existing = tx
      .select({ id: member.id })
      .from(member)
      .where(eq(member.userId, userId))
      .get();
    if (existing !== undefined) throw new AlreadyMemberError();
    insertMember(tx, organizationIn(tx).id, userId, role);
    recordAuditEvent(
      {
        actor,
        action: "member_added",
        target: account.email,
        details: { email: account.email, role },
        sessionId: null,
      },
      tx,
    );
  });
}

export function updateMemberRole(
  memberId: string,
  role: RoleName,
  actor: Actor,
): void {
  getDb().transaction((tx) => {
    const target = memberIn(tx, memberId);
    if (target.role === role) return;
    if (role !== ADMIN_ROLE) refuseLastAdmin(tx, target);
    tx.update(member).set({ role }).where(eq(member.id, memberId)).run();
    recordAuditEvent(
      {
        actor,
        action: "member_role_changed",
        target: target.email,
        details: { email: target.email, role, previousRole: target.role },
        sessionId: null,
      },
      tx,
    );
  });
}

// The account stays with its chats hidden; its sessions end here so no cookie outlives the membership.
export function removeMember(memberId: string, actor: Actor): void {
  getDb().transaction((tx) => {
    const target = memberIn(tx, memberId);
    refuseLastAdmin(tx, target);
    tx.delete(teamMember).where(eq(teamMember.userId, target.userId)).run();
    tx.delete(member).where(eq(member.id, memberId)).run();
    deleteSessionsOf(target.userId, tx);
    recordAuditEvent(
      {
        actor,
        action: "member_removed",
        target: target.email,
        details: { email: target.email, role: target.role },
        sessionId: null,
      },
      tx,
    );
  });
}

// The token is returned once and only its hash is stored. Inviting an address again cancels its pending one.
export function createInvitation(
  input: { email: string; role: RoleName; teamIds: string[] },
  actor: Actor,
): { id: string; token: string; organizationName: string } {
  const id = randomUUID();
  const token = issueToken("nwv");
  const email = input.email.toLowerCase();
  const teamIds = [...new Set(input.teamIds)];
  const organizationName = getDb().transaction((tx) => {
    const { id: organizationId, name } = organizationIn(tx);
    if (teamIds.length > 0) {
      const known = tx
        .select({ id: team.id })
        .from(team)
        .where(inArray(team.id, teamIds))
        .all();
      if (known.length !== teamIds.length) {
        throw new NotFoundError("unknown team");
      }
    }
    // At most one is pending, since each invitation cancels the one before it.
    const { changes: replaced } = tx
      .update(invitation)
      .set({ status: "canceled" })
      .where(and(eq(invitation.email, email), eq(invitation.status, "pending")))
      .run();
    if (replaced > 0) {
      recordAuditEvent(
        {
          actor,
          action: "invitation_canceled",
          target: email,
          details: { email },
          sessionId: null,
        },
        tx,
      );
    }
    const now = Date.now();
    tx.insert(invitation)
      .values({
        id,
        organizationId,
        tokenHash: hashToken(token),
        email,
        role: input.role,
        status: "pending",
        inviterId: actor.id,
        expiresAt: new Date(now + INVITATION_LIFETIME_S * 1000).toISOString(),
        createdAt: new Date(now).toISOString(),
      })
      .run();
    if (teamIds.length > 0) {
      tx.insert(invitationTeam)
        .values(teamIds.map((teamId) => ({ invitationId: id, teamId })))
        .run();
    }
    recordAuditEvent(
      {
        actor,
        action: "member_invited",
        target: email,
        details: { email, role: input.role },
        sessionId: null,
      },
      tx,
    );
    return name;
  });
  return { id, token, organizationName };
}

export function cancelInvitation(invitationId: string, actor: Actor): void {
  getDb().transaction((tx) => {
    const found = tx
      .select({ email: invitation.email, status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, invitationId))
      .get();
    if (found?.status !== "pending") {
      throw new NotFoundError("unknown invitation");
    }
    tx.update(invitation)
      .set({ status: "canceled" })
      .where(eq(invitation.id, invitationId))
      .run();
    recordAuditEvent(
      {
        actor,
        action: "invitation_canceled",
        target: found.email,
        details: { email: found.email },
        sessionId: null,
      },
      tx,
    );
  });
}

// The person joining is the actor, since nobody else did anything.
export function acceptInvitation(invitationId: string, userId: string): void {
  getDb().transaction((tx) => {
    const found = tx
      .select()
      .from(invitation)
      .where(eq(invitation.id, invitationId))
      .get();
    const person = tx
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    const alreadyMember = tx
      .select({ id: member.id })
      .from(member)
      .where(eq(member.userId, userId))
      .get();
    if (
      found?.status !== "pending" ||
      Date.parse(found.expiresAt) <= Date.now() ||
      person === undefined ||
      person.email.toLowerCase() !== found.email ||
      alreadyMember !== undefined
    ) {
      throw new InvitationNotValidError();
    }
    insertMember(tx, found.organizationId, userId, found.role);
    const joined = tx
      .select({ teamId: invitationTeam.teamId })
      .from(invitationTeam)
      .where(eq(invitationTeam.invitationId, found.id))
      .all();
    if (joined.length > 0) {
      tx.insert(teamMember)
        .values(
          joined.map(({ teamId }) => ({ teamId, userId, createdAt: nowIso() })),
        )
        .run();
    }
    tx.update(invitation)
      .set({ status: "accepted" })
      .where(eq(invitation.id, found.id))
      .run();
    recordAuditEvent(
      {
        actor: { id: person.id, name: person.name, email: person.email },
        action: "member_joined",
        target: found.email,
        details: { email: found.email, role: found.role },
        sessionId: null,
      },
      tx,
    );
  });
}

export function createTeam(
  name: string,
  actor: Actor,
): { id: string; name: string } {
  const id = randomUUID();
  getDb().transaction((tx) => {
    tx.insert(team)
      .values({
        id,
        organizationId: organizationIn(tx).id,
        name,
        createdAt: nowIso(),
      })
      .run();
    recordAuditEvent(
      {
        actor,
        action: "team_created",
        target: id,
        details: { name },
        sessionId: null,
      },
      tx,
    );
  });
  return { id, name };
}

export function renameTeam(teamId: string, name: string, actor: Actor): void {
  getDb().transaction((tx) => {
    const found = teamIn(tx, teamId);
    tx.update(team).set({ name }).where(eq(team.id, teamId)).run();
    recordAuditEvent(
      {
        actor,
        action: "team_renamed",
        target: teamId,
        details: { name, previousName: found.name },
        sessionId: null,
      },
      tx,
    );
  });
}

export function deleteTeam(teamId: string, actor: Actor): void {
  getDb().transaction((tx) => {
    const found = teamIn(tx, teamId);
    if (found.isDefault) throw new DefaultTeamError();
    tx.delete(team).where(eq(team.id, teamId)).run();
    recordAuditEvent(
      {
        actor,
        action: "team_deleted",
        target: teamId,
        details: { name: found.name },
        sessionId: null,
      },
      tx,
    );
  });
}

// Adding someone already in the team changes nothing and records nothing.
export function addTeamMember(
  teamId: string,
  userId: string,
  actor: Actor,
): void {
  getDb().transaction((tx) => {
    const found = teamIn(tx, teamId);
    const person = tx
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.userId, userId))
      .get();
    if (person === undefined) throw new NotFoundError("unknown member");
    const { changes } = tx
      .insert(teamMember)
      .values({ teamId, userId, createdAt: nowIso() })
      .onConflictDoNothing()
      .run();
    if (changes === 0) return;
    recordAuditEvent(
      {
        actor,
        action: "team_member_added",
        target: person.email,
        details: { email: person.email, team: found.name },
        sessionId: null,
      },
      tx,
    );
  });
}

// Removing someone who is not in the team changes nothing and records nothing.
export function removeTeamMember(
  teamId: string,
  userId: string,
  actor: Actor,
): void {
  getDb().transaction((tx) => {
    const found = teamIn(tx, teamId);
    const person = tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    if (person === undefined) throw new NotFoundError("unknown member");
    const { changes } = tx
      .delete(teamMember)
      .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)))
      .run();
    if (changes === 0) return;
    recordAuditEvent(
      {
        actor,
        action: "team_member_removed",
        target: person.email,
        details: { email: person.email, team: found.name },
        sessionId: null,
      },
      tx,
    );
  });
}

export function readOrganization(): Organization | undefined {
  const found = getDb().select().from(organization).get();
  return found === undefined ? undefined : organizationOf(found);
}

export function organizationExists(): boolean {
  return (
    getDb().select({ id: organization.id }).from(organization).get() !==
    undefined
  );
}

// A null role is an account with no membership, which is what removing someone leaves behind.
export function accessOf(userId: string): {
  role: RoleName | null;
  requireMfa: boolean;
} {
  const found = getDb()
    .select({ role: member.role, requireMfa: organization.requireMfa })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .get();
  return found === undefined
    ? { role: null, requireMfa: false }
    : { role: found.role, requireMfa: effectiveRequireMfa(found.requireMfa) };
}

export function memberUserId(memberId: string): string | undefined {
  return getDb()
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.id, memberId))
    .get()?.userId;
}

function teamsByUser(): Map<string, { id: string; name: string }[]> {
  const rows = getDb()
    .select({ userId: teamMember.userId, id: team.id, name: team.name })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .orderBy(asc(team.name))
    .all();
  const byUser = new Map<string, { id: string; name: string }[]>();
  for (const { userId, ...ref } of rows) {
    byUser.set(userId, [...(byUser.get(userId) ?? []), ref]);
  }
  return byUser;
}

export function listMembers(): OrganizationMember[] {
  const teams = teamsByUser();
  const rows = getDb()
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      mfaEnabled: user.twoFactorEnabled,
      joinedAt: member.createdAt,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .orderBy(asc(member.createdAt), asc(member.id))
    .all();
  return rows.map((row) => ({ ...row, teams: teams.get(row.userId) ?? [] }));
}

export function isMemberEmail(email: string): boolean {
  return (
    getDb()
      .select({ id: member.id })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, email.toLowerCase()))
      .get() !== undefined
  );
}

export function listPendingInvitations(): OrganizationInvitation[] {
  const rows = getDb()
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      inviterName: user.name,
    })
    .from(invitation)
    .leftJoin(user, eq(user.id, invitation.inviterId))
    .where(
      and(eq(invitation.status, "pending"), gt(invitation.expiresAt, nowIso())),
    )
    .orderBy(asc(invitation.createdAt), asc(invitation.id))
    .all();
  const teams =
    rows.length === 0
      ? []
      : getDb()
          .select({
            invitationId: invitationTeam.invitationId,
            id: team.id,
            name: team.name,
          })
          .from(invitationTeam)
          .innerJoin(team, eq(team.id, invitationTeam.teamId))
          .where(
            inArray(
              invitationTeam.invitationId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(asc(team.name))
          .all();
  return rows.map((row) => ({
    ...row,
    teams: teams
      .filter((joined) => joined.invitationId === row.id)
      .map(({ id, name }) => ({ id, name })),
  }));
}

/* Unknown, canceled and accepted tokens answer alike. The pending rows are compared
   one by one, since an index lookup's timing would answer for a guess. */
export function findPendingInvitationByToken(
  token: string,
): PendingInvitation | undefined {
  const found = getDb()
    .select({
      id: invitation.id,
      tokenHash: invitation.tokenHash,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      organizationName: organization.name,
      inviterName: user.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .leftJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.status, "pending"))
    .all()
    .find((row) => tokenMatches(token, row.tokenHash));
  if (found === undefined) return undefined;
  const { tokenHash: _tokenHash, expiresAt, ...rest } = found;
  return { ...rest, expired: Date.parse(expiresAt) <= Date.now() };
}

export function listTeams(): OrganizationTeam[] {
  return getDb()
    .select({
      id: team.id,
      name: team.name,
      isDefault: team.isDefault,
      createdAt: team.createdAt,
      memberCount: count(teamMember.userId),
    })
    .from(team)
    .leftJoin(teamMember, eq(teamMember.teamId, team.id))
    .groupBy(team.id)
    .orderBy(asc(team.name), asc(team.id))
    .all();
}
