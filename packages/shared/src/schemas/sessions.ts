// What the session routes answer. A session is the agent's conversation thread,
// and an investigation is a session opened by an alert.
import { z } from "zod";
import { approvalStatusSchema, transcriptItemSchema } from "./transcript.js";

const stringMap = z.record(z.string(), z.string());

// No target: an alert names no service on its own. Resolution asks the live fleet
// which advertised service the labels describe, so nothing speculative is stored.
const normalizedAlertSchema = z.object({
  sourceAlertId: z.string(),
  labels: stringMap,
  // What a human wrote about this condition. Context only, never a control input.
  annotations: stringMap,
  alertType: z.string(),
  firedAt: z.string(),
  // Where the sender says the condition lives. Grafana names a rule page.
  generatorURL: z.string().nullable(),
  // What the rule evaluated to when it fired, keyed by the query behind each number.
  values: z.record(z.string(), z.number()),
});
export type NormalizedAlert = z.infer<typeof normalizedAlertSchema>;

// Every field is optional on the wire, so an absent one is an empty map rather
// than a reason to reject the body.
const alertGroupContextSchema = z.object({
  groupLabels: stringMap,
  commonLabels: stringMap,
  commonAnnotations: stringMap,
});
export type AlertGroupContext = z.infer<typeof alertGroupContextSchema>;

// Derived server-side and never declared by the model. `not_started` is held by
// the hourly limit until a person starts it.
const investigationStatusSchema = z.enum([
  "action_required",
  "running",
  "resolved",
  "stopped",
  "failed",
  "completed",
  "not_started",
]);
export type InvestigationStatus = z.infer<typeof investigationStatusSchema>;

const sessionMetaSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  createdAt: z.string(),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

// One alert on a session, with the facts the alert itself cannot carry: when it
// joined, whether the condition has since recovered, and how it got here.
const sessionAlertSchema = z.object({
  alert: normalizedAlertSchema,
  arrivedAt: z.string(),
  clearedAt: z.string().nullable(),
  // True when it arrived mid-run rather than opening the session.
  injected: z.boolean(),
  // How many alerts the source left out of the delivery this one arrived in.
  droppedAlerts: z.number(),
  // What that delivery said about the group as a whole, or null when it said nothing.
  groupContext: alertGroupContextSchema.nullable(),
});
export type SessionAlert = z.infer<typeof sessionAlertSchema>;

// One row of the frontend's one session list. A session not under investigation
// leaves the status fields null.
const sessionListRowSchema = sessionMetaSchema.extend({
  lastActivityAt: z.string(),
  investigation: z.boolean(),
  severityLabel: z.string().nullable(),
  status: investigationStatusSchema.nullable(),
  // One line answering the question the status raises. Null when there is nothing to say.
  statusLine: z.string().nullable(),
  // Its own field, because any session can be waiting on a human.
  awaitingHumanInput: z.boolean(),
});
export type SessionListRow = z.infer<typeof sessionListRowSchema>;

// The rows are one page; the total is a claim about every investigation, which a
// page cannot answer.
export const sessionListPageSchema = z.object({
  rows: z.array(sessionListRowSchema),
  // The offset to request next, or null once the list is exhausted.
  nextOffset: z.number().nullable(),
  investigationTotal: z.number(),
});
export type SessionListPage = z.infer<typeof sessionListPageSchema>;

// The session states whether it is under investigation itself, so no consumer
// infers it from a run's leftovers.
export const sessionDetailSchema = sessionMetaSchema.extend({
  investigation: z.boolean(),
  // The last thing that happened on it, which a finished record is timed to.
  lastActivityAt: z.string(),
  // Without it, a session rejoined mid-run reads as idle until the next event lands.
  running: z.boolean(),
  // Written up and closed, idle and waiting on nobody, as the reopen route requires.
  reopenable: z.boolean(),
  // In arrival order: the batch that opened the session, then any injected later.
  alerts: z.array(sessionAlertSchema),
  transcript: z.array(transcriptItemSchema),
});
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

// A run was handed out for this session, which the next request can already fetch.
export const sessionAcceptedSchema = z.object({ sessionId: z.string() });

export const sessionStoppedSchema = z.object({ stopped: z.literal(true) });

export const approvalResponseSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  status: approvalStatusSchema,
  resolvedAt: z.string(),
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
