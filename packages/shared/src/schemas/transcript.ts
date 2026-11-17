// Built server-side from the stored transcript joined with whatever the session
// is suspended on. The browser draws these and never derives a call's state.
import { z } from "zod";
import { actorSchema, verdictSchema } from "./report.js";

// Two outcomes only: a rejection carries the user's comment back, so there is
// no third "added context" for the agent to read as success.
export const approvalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "answered",
  "continued",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

// Named as the gate names it, so there is one vocabulary. It lives on the one
// phase where it means anything, so a settled call cannot contradict it.
const toolGateSchema = z.enum(["approval", "clarification"]);
export type ToolGate = z.infer<typeof toolGateSchema>;

// Explicit rather than an optional field, so "not set" is never a meaning. A
// decision in flight is the component's own concern and never appears here.
const toolCallStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("running") }),
  z.object({ phase: z.literal("awaiting_human"), gate: toolGateSchema }),
  // `result` arrives once the tool that was waiting has run. `actor` is absent
  // on a decision recorded before it was tracked.
  z.object({
    phase: z.literal("resolved"),
    decision: approvalStatusSchema,
    result: z.unknown().optional(),
    actor: actorSchema.optional(),
  }),
  z.object({
    phase: z.literal("complete"),
    result: z.unknown(),
    isError: z.literal(true).optional(),
  }),
]);
export type ToolCallState = z.infer<typeof toolCallStateSchema>;

const userTurnItemSchema = z.object({
  kind: z.literal("user_turn"),
  id: z.string(),
  text: z.string(),
  // When its row was written; present on a projected item, absent while live.
  timestamp: z.string().optional(),
});
export type UserTurnItem = z.infer<typeof userTurnItemSchema>;

const agentTextItemSchema = z.object({
  kind: z.literal("agent_text"),
  id: z.string(),
  text: z.string(),
  // Which turn wrote it; a streamed copy carries the same number.
  turn: z.number(),
  timestamp: z.string().optional(),
});
export type AgentTextItem = z.infer<typeof agentTextItemSchema>;

// NightWarden's own failure note (role "error"), rendered exactly like agent text.
const errorTextItemSchema = z.object({
  kind: z.literal("error_text"),
  id: z.string(),
  text: z.string(),
});
export type ErrorTextItem = z.infer<typeof errorTextItemSchema>;

// One item for the whole life of a call. Arguments travel whole in `input`,
// because a copy is a second source.
const toolCallItemSchema = z.object({
  kind: z.literal("tool_call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  // How many times this same write already ran, counted from the transcript.
  // The card informs, it never refuses; only a walk can answer it.
  priorRuns: z.number().optional(),
  state: toolCallStateSchema,
  timestamp: z.string().optional(),
});
export type ToolCallItem = z.infer<typeof toolCallItemSchema>;

// Not a tool call: no model asked for it, and its synthetic id keys an
// interrupt row. So it carries two states rather than a tool's four.
const continueCardItemSchema = z.object({
  kind: z.literal("continue_card"),
  toolCallId: z.string(),
  state: z.discriminatedUnion("phase", [
    z.object({ phase: z.literal("awaiting_human") }),
    z.object({ phase: z.literal("resolved"), decision: approvalStatusSchema }),
  ]),
});
export type ContinueCardItem = z.infer<typeof continueCardItemSchema>;

// `building` is live only, being the phase of a turn in flight; the other two
// are read back from whether the session holds a report.
const reportCardItemSchema = z.object({
  kind: z.literal("report_card"),
  id: z.string(),
  state: z.object({ phase: z.enum(["building", "ready", "failed"]) }),
  // The report's own headline, present once a report stands.
  headline: z.string().optional(),
});
export type ReportCardItem = z.infer<typeof reportCardItemSchema>;

// "open" until a finding settles the candidate, otherwise that finding's verdict.
const candidateRowSchema = z.object({
  id: z.string(),
  statement: z.string(),
  state: z.union([z.literal("open"), verdictSchema]),
  note: z.string().optional(),
});
export type CandidateRow = z.infer<typeof candidateRowSchema>;

// The candidate board, docked above the input and refreshed as findings settle
// each one. One per session, keyed on its id like the report card.
const candidateCardItemSchema = z.object({
  kind: z.literal("candidate_card"),
  id: z.string(),
  rows: z.array(candidateRowSchema),
});
export type CandidateCardItem = z.infer<typeof candidateCardItemSchema>;

// Placed where it interrupted. The report holds the detail; this says only
// that the ground moved, so a change of course has a visible cause.
const alertArrivedItemSchema = z.object({
  kind: z.literal("alert_arrived"),
  id: z.string(),
  alertType: z.string(),
  // Whatever the sender called it, verbatim. Null when it carried no label.
  severityLabel: z.string().nullable(),
  // True for the alert the session opened on, which reads as its beginning.
  opening: z.boolean().optional(),
});
export type AlertArrivedItem = z.infer<typeof alertArrivedItemSchema>;

// Where the provider summarised everything above to fit its window. The
// evidence is untouched: a compacted tool result is still in the record.
const compactionItemSchema = z.object({
  kind: z.literal("compaction"),
  id: z.string(),
});
export type CompactionItem = z.infer<typeof compactionItemSchema>;

export const transcriptItemSchema = z.discriminatedUnion("kind", [
  userTurnItemSchema,
  agentTextItemSchema,
  errorTextItemSchema,
  toolCallItemSchema,
  continueCardItemSchema,
  reportCardItemSchema,
  candidateCardItemSchema,
  alertArrivedItemSchema,
  compactionItemSchema,
]);
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;
