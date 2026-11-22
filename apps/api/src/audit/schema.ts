import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { AUDIT_ACTIONS, type AuditEvent } from "@nightwarden/shared";
import { inList } from "../schema-helpers.js";

export const auditEvent = sqliteTable(
  "audit_event",
  {
    id: integer("id").primaryKey(),
    at: text("at").notNull(),
    // The actor's name and email are copied, so the record outlives the account.
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    actorEmail: text("actor_email").notNull(),
    action: text("action", { enum: AUDIT_ACTIONS }).notNull(),
    // What was acted on, such as a call's target key; null when it names none.
    target: text("target"),
    details: text("details", { mode: "json" })
      .$type<AuditEvent["details"]>()
      .notNull(),
    // No foreign key: the event outlives the session it happened in.
    sessionId: text("session_id"),
  },
  (t) => [
    check("audit_event_action", sql`${t.action} IN (${inList(AUDIT_ACTIONS)})`),
    index("idx_audit_event_at").on(t.at),
  ],
);
