import { z } from "zod";
import type { AuditAction } from "../audit.js";
import { ROLE_NAMES } from "../roles.js";

const role = z.enum(ROLE_NAMES);

// The actor's name and email are copied in, so a row outlives the account it names.
const eventOf = <Action extends AuditAction, Details extends z.ZodType>(
  action: Action,
  details: Details,
) =>
  z.object({
    id: z.number(),
    at: z.string(),
    actorId: z.string(),
    actorName: z.string(),
    actorEmail: z.string(),
    action: z.literal(action),
    // What was acted on: a call's target key, a person's email or a team's id; null when none.
    target: z.string().nullable(),
    details,
    // The session it happened in, which may since have been deleted.
    sessionId: z.string().nullable(),
  });

// The tool, its input, and the reason a person gave for a rejection.
const write = z.object({
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  reason: z.string().optional(),
});
const person = z.object({ email: z.string(), role });
const team = z.object({ name: z.string() });
const teamMembership = z.object({ email: z.string(), team: z.string() });

const auditEventSchema = z.discriminatedUnion("action", [
  eventOf("write_approved", write),
  eventOf("write_rejected", write),
  eventOf("organization_created", z.object({ name: z.string() })),
  eventOf(
    "organization_updated",
    z.object({ fields: z.array(z.enum(["name", "logo"])) }),
  ),
  eventOf("member_added", person),
  eventOf("member_invited", person),
  eventOf("invitation_canceled", z.object({ email: z.string() })),
  eventOf("member_joined", person),
  eventOf(
    "member_role_changed",
    z.object({ email: z.string(), role, previousRole: role }),
  ),
  eventOf("member_removed", person),
  eventOf("team_created", team),
  eventOf(
    "team_renamed",
    z.object({ name: z.string(), previousName: z.string() }),
  ),
  eventOf("team_deleted", team),
  eventOf("team_member_added", teamMembership),
  eventOf("team_member_removed", teamMembership),
]);

// Resolves to a type naming the missing action when AUDIT_ACTIONS and the schema drift apart.
type CoveringAllActions<Event extends { action: AuditAction }> = [
  AuditAction,
] extends [Event["action"]]
  ? Event
  : { missingSchemaFor: Exclude<AuditAction, Event["action"]> };
export type AuditEvent = CoveringAllActions<z.infer<typeof auditEventSchema>>;

export const auditPageSchema = z.object({
  events: z.array(auditEventSchema),
  // The offset to request next, or null once the trail is exhausted.
  nextOffset: z.number().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;
