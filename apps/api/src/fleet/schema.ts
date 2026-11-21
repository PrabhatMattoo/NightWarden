import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { PLATFORMS } from "@nightwarden/shared";
import { inList } from "../schema-helpers.js";

export const runner = sqliteTable(
  "runner",
  {
    id: text("id").primaryKey(),
    // The SHA-256 hash, never the credential.
    token: text("token").notNull().unique(),
    platform: text("platform", { enum: PLATFORMS }).notNull(),
    serverName: text("server_name").notNull().unique(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [
    check("runner_platform", sql`${t.platform} IN (${inList(PLATFORMS)})`),
  ],
);
