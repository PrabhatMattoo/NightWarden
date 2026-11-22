// Snake_case columns, so a move to Postgres never needs a quoted identifier.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { THEME_PREFERENCES } from "@nightwarden/shared";
import { inList } from "../schema-helpers.js";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
    image: text("image"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    // 'admin' or 'member', the owner created as 'admin' by the setup route.
    role: text("role"),
    banned: integer("banned", { mode: "boolean" }),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),
    theme: text("theme", { enum: THEME_PREFERENCES })
      .notNull()
      .default("system"),
  },
  (t) => [
    check("user_theme", sql`${t.theme} IN (${inList(THEME_PREFERENCES)})`),
  ],
);

// Renamed from Better Auth's `session`, which sits one letter from `sessions`.
export const authSession = sqliteTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("auth_session_user_id_idx").on(t.userId)],
);

// Email and password is the 'credential' row, holding the argon2id hash.
export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// Wrong passwords per account, counted so a guesser is slowed from any address.
export const signInFailure = sqliteTable(
  "sign_in_failure",
  {
    id: integer("id").primaryKey(),
    email: text("email").notNull(),
    failedAt: text("failed_at").notNull(),
  },
  (t) => [index("sign_in_failure_email_failed_at_idx").on(t.email, t.failedAt)],
);
