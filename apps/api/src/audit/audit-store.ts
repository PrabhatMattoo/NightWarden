import { desc } from "drizzle-orm";
import type { Actor, AuditAction, AuditEvent } from "@nightwarden/shared";
import { type Db, getDb } from "../db.js";
import { auditEvent } from "./schema.js";

export interface NewAuditEvent {
  actor: Actor;
  action: AuditAction;
  target: string | null;
  details: AuditEvent["details"];
  sessionId: string | null;
}

// Takes the Db so a decision and its record land in one transaction.
export function recordAuditEvent(event: NewAuditEvent, db: Db = getDb()): void {
  const { actor, ...rest } = event;
  db.insert(auditEvent)
    .values({
      ...rest,
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
    })
    .run();
}

// Newest first, with the id as the tiebreak so two events in one millisecond keep an order.
export function listAuditEvents(limit: number, offset: number) {
  const rows = getDb()
    .select()
    .from(auditEvent)
    .orderBy(desc(auditEvent.at), desc(auditEvent.id))
    .limit(limit + 1)
    .offset(offset)
    .all();
  return {
    events: rows.slice(0, limit),
    // One extra row answers "is there a next page?" without a count.
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}
