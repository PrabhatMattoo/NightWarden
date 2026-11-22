import { z } from "zod";
import { AUDIT_ACTIONS } from "../audit.js";

// The actor's name and email are copied in, so a row outlives the account it names.
const auditEventSchema = z.object({
  id: z.number(),
  at: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  actorEmail: z.string(),
  action: z.enum(AUDIT_ACTIONS),
  // What was acted on, such as a call's target key; null when the call names none.
  target: z.string().nullable(),
  // For a write: the tool, its input, and the reason a person gave for a rejection.
  details: z.object({
    tool: z.string(),
    input: z.record(z.string(), z.unknown()),
    reason: z.string().optional(),
  }),
  // The session it happened in, which may since have been deleted.
  sessionId: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditPageSchema = z.object({
  events: z.array(auditEventSchema),
  // The offset to request next, or null once the trail is exhausted.
  nextOffset: z.number().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;
