// Times are ISO-8601 text. A person's role lives on member alone, so no row means no access.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { INVITATION_STATUSES, ROLE_NAMES } from "@nightwarden/shared";
import { user } from "../auth/schema.js";
import { inList } from "../schema-helpers.js";

export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  logo: text("logo"),
  createdAt: text("created_at").notNull(),
});

export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLE_NAMES }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [check("member_role", sql`${t.role} IN (${inList(ROLE_NAMES)})`)],
);

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    role: text("role", { enum: ROLE_NAMES }).notNull(),
    status: text("status", { enum: INVITATION_STATUSES }).notNull(),
    inviterId: text("inviter_id").references(() => user.id, {
      onDelete: "set null",
    }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("invitation_role", sql`${t.role} IN (${inList(ROLE_NAMES)})`),
    check(
      "invitation_status",
      sql`${t.status} IN (${inList(INVITATION_STATUSES)})`,
    ),
    index("invitation_email_status_idx").on(t.email, t.status),
  ],
);

export const team = sqliteTable(
  "team",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Made at setup and never deleted, so integrations always have a team to fall back to.
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("team_one_default_idx")
      .on(t.isDefault)
      .where(sql`${t.isDefault} = 1`),
  ],
);

export const invitationTeam = sqliteTable(
  "invitation_team",
  {
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitation.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.invitationId, t.teamId] })],
);

export const teamMember = sqliteTable(
  "team_member",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);
