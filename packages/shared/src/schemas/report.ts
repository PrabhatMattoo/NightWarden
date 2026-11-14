// The investigation record as GET /sessions/:id/report serves it, joined with
// the decisions and evidence the transcript answers.
import { z } from "zod";

// The signed-in person who made a human decision, stamped from the request's own
// session so the audit trail names who, not just what. Optional on older parts.
export const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});
export type Actor = z.infer<typeof actorSchema>;

// Six, so a run has a home for "I had no way to test it" apart from "I tested it
// and it is false". Recorded once tested, so there is no "open" finding.
export const verdictSchema = z.enum([
  "root_cause",
  "trigger",
  "symptom",
  "contributing_factor",
  "disproven",
  "untestable",
]);
export type Verdict = z.infer<typeof verdictSchema>;

// A hypothesis the agent commits to before testing it, carrying what it expects
// to see if it holds and what would prove it wrong.
const candidateSchema = z.object({
  // c1, c2..., assigned by the system in opening order.
  id: z.string(),
  statement: z.string(),
  ifTrue: z.string(),
  ifFalse: z.string(),
  // The candidate this one explains, when it goes a step deeper into a cause.
  parent: z.string().optional(),
  // The highest evidence id in hand when the candidate opened, so a finding is
  // held to a result gathered after it rather than to the reads that raised it.
  openedAtEvidence: z.number(),
});
export type Candidate = z.infer<typeof candidateSchema>;

const findingSchema = z.object({
  // f1, f2..., assigned in recording order, so a later call cannot rewrite an earlier row.
  id: z.string(),
  verdict: verdictSchema,
  // The candidate this finding settles, and where its claim is read from.
  candidate: z.string(),
  // What the cited results showed, and why they settle it this way.
  explanation: z.string(),
  evidenceIds: z.array(z.string()),
  recordedAt: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

// `action` is absent because it is not the model's to claim: the system
// contributes a released write, carrying `action` below.
const timelineLaneSchema = z.enum(["change", "signal", "agent"]);
export type TimelineLane = z.infer<typeof timelineLaneSchema>;

// The model authors these; the system adds a row per released write, so an
// action cannot be left off a timeline the model did not author in full.
const timelineEntrySchema = z.object({
  at: z.string(),
  what: z.string(),
  // Absent on a system row, which the model does not write.
  lane: timelineLaneSchema.optional(),
  evidenceId: z.string().optional(),
  // Present only on a system row, which names the tool that ran.
  action: z
    .object({
      toolName: z.string(),
      target: z.string().nullable(),
      decision: z.enum(["approved", "rejected"]),
      isError: z.boolean().optional(),
      actor: actorSchema.optional(),
    })
    .optional(),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

// Written in one call over complete findings, and it restates none of them: this
// is the prose they have nowhere to put.
const submittedReportSchema = z.object({
  headline: z.string(),
  // A short noun phrase naming who was hit.
  affected: z.string(),
  // Where the incident stands as the report is written. The findings carry the cause.
  summary: z.string(),
  timeline: z.array(timelineEntrySchema),
  impact: z.string(),
  // What the user should do, never a claim that anything has been done.
  recommendation: z.string(),
  submittedAt: z.string(),
});
export type SubmittedReport = z.infer<typeof submittedReportSchema>;

const investigationRecordSchema = z.object({
  candidates: z.array(candidateSchema),
  findings: z.array(findingSchema),
  // Null until the run reaches its composition turn, which several endings never do.
  report: submittedReportSchema.nullable(),
  updatedAt: z.string(),
});
export type InvestigationRecord = z.infer<typeof investigationRecordSchema>;

// Declared on the tool so the frontend picks a renderer rather than guessing
// from the result: a declaration cannot drift from what the tool returns.
const evidenceKindSchema = z.enum([
  "metric",
  "logs",
  "change",
  "state",
  "diff",
  "terminal",
  "exception",
  "text",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

// One cited tool call, resolved from the transcript at read time so the report
// quotes what ran rather than storing a second copy of it.
const resolvedEvidenceSchema = z.object({
  // Two ids, because a claim cites one and the frontend reveals the other.
  evidenceId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  kind: evidenceKindSchema,
  input: z.record(z.string(), z.unknown()),
  result: z.string(),
  // Present only where a person was asked, since a declined call never ran.
  approved: z.boolean().optional(),
});
export type ResolvedEvidence = z.infer<typeof resolvedEvidenceSchema>;

// The person who released the write is stamped from their signed-in session at
// the moment they decided; `actor` is absent only on a pre-attribution row.
const gatedCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  target: z.string().nullable(),
  // When it answered, which is what places it on the timeline.
  at: z.string(),
  decision: z.enum(["approved", "rejected"]),
  actor: actorSchema.optional(),
  isError: z.boolean().optional(),
  // Only worth reading on a failure: a success is its own output.
  result: z.string().nullable(),
});
export type GatedCall = z.infer<typeof gatedCallSchema>;

// Two authors: the model writes `record`, and the transcript answers both
// `decisions` and `evidence`.
export const sessionReportResponseSchema = z.object({
  record: investigationRecordSchema,
  decisions: z.array(gatedCallSchema),
  evidence: z.array(resolvedEvidenceSchema),
});
export type SessionReportResponse = z.infer<typeof sessionReportResponseSchema>;
