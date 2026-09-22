// The only place the record is written, and the owner of its rules: a citation
// is the id of the call that produced it, and nothing is unrecorded.

import type {
  Candidate,
  Actor,
  EvidenceKind,
  Finding,
  GatedCall,
  InvestigationRecord,
  ResolvedEvidence,
  TimelineEntry,
  TranscriptRow,
  Verdict,
} from "@nightwarden/shared";
import { openCandidateIds } from "@nightwarden/shared";
import {
  amendRecord,
  getRecord,
  updateRecord,
} from "../session/record-store.js";
import { getTranscriptRows } from "../session/transcript-store.js";
import { publishReportUpdated } from "../session/stream.js";
import { targetKeyFromInput } from "../session/transcript.js";
import { evidenceNumber, highestEvidenceNumber } from "./evidence-id.js";
import { DOCKER_TOOLS } from "./tools/docker.js";
import { GITHUB_TOOLS } from "./tools/github.js";
import { HOST_TOOLS } from "./tools/host.js";
import { K8S_TOOLS } from "./tools/kubernetes.js";
import { LOKI_TOOLS } from "./tools/loki.js";
import { METRICS_TOOLS } from "./tools/metrics.js";
import { REPO_TOOLS } from "./tools/repo.js";
import { SENTRY_TOOLS } from "./tools/sentry.js";

/* Held apart from the registry, which reaches the record's own tools and would
   cycle back through here. Each entry is read off the tool, never listed. */
const RENDERER = new Map<string, EvidenceKind>(
  [
    DOCKER_TOOLS,
    HOST_TOOLS,
    K8S_TOOLS,
    REPO_TOOLS,
    GITHUB_TOOLS,
    METRICS_TOOLS,
    LOKI_TOOLS,
    SENTRY_TOOLS,
  ]
    .flat()
    .flatMap((tool) =>
      tool.citable ? [[tool.schema.name, tool.renderAs] as const] : [],
    ),
);

/* Opening a candidate, recording a finding, writing the report and asking a
   person observe nothing, so none earns an evidence id and none can back a claim. */
export function isCitable(toolName: string): boolean {
  return RENDERER.has(toolName);
}

// A cited call whose tool this build no longer offers reads as plain text: its
// result is still quotable, just no longer typed.
function evidenceKind(toolName: string): EvidenceKind {
  return RENDERER.get(toolName) ?? "text";
}

// What a recording tool tells the model. A refusal is a correction, not a fault:
// the act was rejected and the message says what to do instead.
export interface RecordOutcome {
  recorded: boolean;
  message: string;
}

export interface ToolCall {
  toolCallId: string;
  // Absent until the call answers, and absent for good on a tool no claim may
  // rest on: the handle rides the result rather than the request.
  evidenceId?: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string | null;
  // Carried on the result part it belongs to, so one walk answers both what a
  // call returned and whether it failed.
  isError?: boolean;
  // Absent unless a person was asked about this call, which is the only thing
  // that makes it a released write rather than a call the harness ran or refused.
  approved?: boolean;
  // Who released the write, read from the same approval part that carries `approved`.
  actor?: Actor;
  timestamp: string;
}

// One walk of the durable transcript, which is the evidence trail. Handles are
// read off it rather than counted, so this walk cannot disagree with another.
export function toolCallsFrom(messages: readonly TranscriptRow[]): ToolCall[] {
  const entries: ToolCall[] = [];
  const byToolCallId = new Map<string, ToolCall>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const entry: ToolCall = {
          toolCallId: part.toolCallId,
          toolName: part.name,
          input: part.input,
          result: null,
          timestamp: message.timestamp,
        };
        entries.push(entry);
        byToolCallId.set(part.toolCallId, entry);
      } else if (part.type === "tool_result") {
        const entry = byToolCallId.get(part.toolCallId);
        if (entry) {
          entry.result = part.output;
          if (part.evidenceId !== undefined) entry.evidenceId = part.evidenceId;
          if (part.isError === true) entry.isError = true;
        }
      } else if (part.type === "tool_approval") {
        const entry = byToolCallId.get(part.toolCallId);
        if (entry) {
          entry.approved = part.approved;
          if (part.actor !== undefined) entry.actor = part.actor;
        }
      }
    }
  }
  return entries;
}

// The one read a report request makes: every join below is a pure function over
// what it returns, so the same transcript is not fetched three times.
export async function toolCallsIn(sessionId: string): Promise<ToolCall[]> {
  return toolCallsFrom(await getTranscriptRows(sessionId));
}

/* One split, because a handle exists only once its result does: an id naming no
   answered call is unknown whether the model invented it or jumped ahead. */
function knownCitations(
  entries: readonly ToolCall[],
  ids: string[],
): { kept: string[]; unknown: string[] } {
  const issued = new Set(
    entries.flatMap((e) => (e.evidenceId === undefined ? [] : [e.evidenceId])),
  );
  const kept: string[] = [];
  const unknown: string[] = [];
  for (const id of new Set(ids)) {
    // The key it resolved under, which is the form the record keeps.
    const trimmed = id.trim();
    if (issued.has(trimmed)) kept.push(trimmed);
    else unknown.push(id);
  }
  return { kept, unknown };
}

function issuedRange(entries: readonly ToolCall[]): string {
  const highest = entries.reduce(
    (top, e) => Math.max(top, evidenceNumber(e.evidenceId)),
    0,
  );
  if (highest === 0) return "No call you have made can be cited yet.";
  return highest === 1
    ? "This investigation has e1."
    : `This investigation has e1 through e${highest}.`;
}

// One correction, because the model needs the same move either way: cite a
// result it has read.
function citationRefusal(
  entries: readonly ToolCall[],
  unknown: string[],
): string {
  const one = unknown.length === 1;
  return `Not recorded. ${unknown.join(", ")} ${one ? "names" : "name"} no result you have read. ${issuedRange(entries)} A handle arrives inside the result itself, so a tool you asked for in this same reply does not have one yet and its result reaches you in your next message. Record this again citing only results you have already read.`;
}

// Everything the record points at, from either author: the findings' own
// citations and the composed timeline's references.
function citedIds(record: InvestigationRecord): Set<string> {
  const timeline = record.report?.timeline ?? [];
  return new Set([
    ...record.findings.flatMap((f) => f.evidenceIds),
    ...timeline.flatMap((entry) =>
      entry.evidenceId === undefined ? [] : [entry.evidenceId],
    ),
  ]);
}

// Every cited call answered - a citation naming one that had not is refused when
// the claim is made. The outcome rides along: a cited miss and a cited crash differ.
export function resolveEvidence(
  entries: readonly ToolCall[],
  record: InvestigationRecord,
): ResolvedEvidence[] {
  const cited = citedIds(record);
  if (cited.size === 0) return [];
  const resolved: ResolvedEvidence[] = [];
  for (const entry of entries) {
    const { toolCallId, evidenceId, toolName, input, result } = entry;
    if (evidenceId === undefined || !cited.has(evidenceId)) continue;
    if (result === null) continue;
    resolved.push({
      evidenceId,
      toolCallId,
      toolName,
      kind: evidenceKind(toolName),
      input,
      result,
      ...(entry.approved !== undefined && { approved: entry.approved }),
    });
  }
  return resolved;
}

// A name cannot answer this: a refused call carries the name of a gated tool
// and reached no gate. An answered question is not a write.
export function gatedCalls(entries: readonly ToolCall[]): GatedCall[] {
  return entries.flatMap((entry) => {
    const { approved, isError } = entry;
    if (entry.result === null || approved === undefined) return [];
    return [
      {
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        target: targetKeyFromInput(entry.input),
        at: entry.timestamp,
        decision: approved ? "approved" : "rejected",
        ...(isError === true && { isError: true }),
        ...(entry.actor !== undefined && { actor: entry.actor }),
        result: entry.result,
      },
    ];
  });
}

// Only the released ones: a declined write changed nothing, so the write-up owes
// it no recommendation. Monotonic, since a call already answered never un-answers.
export function approvedWriteCount(calls: readonly GatedCall[]): number {
  return calls.filter((c) => c.decision === "approved").length;
}

// A list rather than a boolean, so the record-gaps message can name only what
// is absent and a surviving gap can be logged as itself.
export type RecordGap =
  | { kind: "empty_record" }
  | { kind: "untested_candidates"; open: OpenCandidate[] };

// The id and the statement together, so the turn that asks for a verdict names
// what it is asking about rather than a count the model has to look up.
export interface OpenCandidate {
  id: string;
  statement: string;
}

/* Read off the record: an empty one is named alone, and an open candidate is a
   test the run owes before it can finish. */
export async function recordGaps(sessionId: string): Promise<RecordGap[]> {
  const record = await getRecord(sessionId);
  if (record === undefined || record.findings.length === 0) {
    return [{ kind: "empty_record" }];
  }
  const open = openCandidateRows(record);
  return open.length > 0 ? [{ kind: "untested_candidates", open }] : [];
}

export function openCandidateRows(
  record: InvestigationRecord,
): OpenCandidate[] {
  const byId = new Map(record.candidates.map((c) => [c.id, c]));
  return openCandidateIds(record).flatMap((id) => {
    const candidate = byId.get(id);
    return candidate === undefined
      ? []
      : [{ id, statement: candidate.statement }];
  });
}

interface OpenCandidatesInput {
  candidates: Array<{
    statement: string;
    ifTrue: string;
    ifFalse: string;
    parent?: string;
  }>;
}

// Assigns each id and appends. A parent must name a candidate that already
// exists or one opened earlier in this same call, or it is dropped.
export async function openCandidates(
  sessionId: string,
  input: OpenCandidatesInput,
): Promise<RecordOutcome> {
  // The evidence in hand now, stamped on each candidate so a finding is later
  // held to a result gathered after this point.
  const openedAtEvidence = highestEvidenceNumber(
    await getTranscriptRows(sessionId),
  );
  const opened = await updateRecord(sessionId, (record) => {
    const known = new Set(record.candidates.map((c) => c.id));
    let n = record.candidates.length;
    const added: Candidate[] = input.candidates.map((c) => {
      const id = `c${++n}`;
      known.add(id);
      const parent =
        c.parent !== undefined && known.has(c.parent) ? c.parent : undefined;
      return {
        id,
        statement: c.statement,
        ifTrue: c.ifTrue,
        ifFalse: c.ifFalse,
        openedAtEvidence,
        ...(parent !== undefined && { parent }),
      };
    });
    return {
      next: { ...record, candidates: [...record.candidates, ...added] },
      value: added,
    };
  });
  publishReportUpdated(sessionId);
  return {
    recorded: true,
    message:
      opened.length === 0
        ? "No candidates opened."
        : `Opened ${opened.map((c) => c.id).join(", ")}.`,
  };
}

// The candidate ids named in the last frontier message, so a resumed run reads
// what it already stated rather than restating it.
export async function setLastStatedCandidates(
  sessionId: string,
  ids: string[],
): Promise<void> {
  await amendRecord(sessionId, (record) => ({
    ...record,
    lastStatedCandidates: ids,
  }));
}

interface RecordFindingInput {
  verdict: Verdict;
  explanation: string;
  evidenceIds: string[];
  candidate: string;
}

// Named so the model can correct itself in one turn: a candidate it mistyped is
// worth naming back, and the ids it may use are the record's own.
function unknownCandidate(record: InvestigationRecord, named: string): string {
  const ids = record.candidates.map((c) => c.id);
  const open = openCandidateIds(record);
  const opened =
    ids.length === 0
      ? "This investigation has opened no candidates yet; open them with OpenCandidates."
      : `The candidates on this record are ${ids.join(", ")}${
          open.length > 0 ? `, and ${open.join(", ")} remain open` : ""
        }.`;
  return `${named} is not a candidate on this record, so nothing was recorded. ${opened}`;
}

// A finding rests on a result gathered after the candidate opened, so it tests
// the candidate rather than restating the read that raised it. Null when it holds.
function citationGap(
  candidate: Candidate,
  ids: string[],
  untestable: boolean,
): string | null {
  const afterOpen = ids.filter(
    (id) => evidenceNumber(id) > candidate.openedAtEvidence,
  );
  if (untestable) {
    return afterOpen.length === ids.length
      ? null
      : `Not recorded. An untestable finding may cite nothing, or cite only results from attempts you made after opening ${candidate.id}. Remove the earlier citations, or cite nothing.`;
  }
  if (ids.length === 0) {
    return `Not recorded. A finding needs at least one citation unless its verdict is untestable. Pass the evidence ids of the results that settled ${candidate.id}.`;
  }
  return afterOpen.length === 0
    ? `Not recorded. Every result cited for ${candidate.id} was gathered before you opened ${candidate.id}, so it raised the candidate rather than testing it. Gather a result after opening ${candidate.id} and cite that, or record ${candidate.id} as untestable if no tool can test it.`
    : null;
}

// One act, recorded once the candidate it names has been tested. Append-only: a
// later finding about that candidate carries the verdict that now stands.
export async function recordFinding(
  sessionId: string,
  input: RecordFindingInput,
): Promise<RecordOutcome> {
  const entries = await toolCallsIn(sessionId);
  const { kept, unknown } = knownCitations(entries, input.evidenceIds);
  /* All of them or none: recording what survives changes the claim the model
     made, on a record that says nothing about what it dropped. */
  if (unknown.length > 0) {
    return { recorded: false, message: citationRefusal(entries, unknown) };
  }
  const evidenceIds = kept;
  const untestable = input.verdict === "untestable";
  type Outcome = { refusal: string } | { id: string; open: string[] };
  const outcome = await updateRecord<Outcome>(sessionId, (record) => {
    const candidate = record.candidates.find((c) => c.id === input.candidate);
    if (candidate === undefined) {
      return {
        next: record,
        value: { refusal: unknownCandidate(record, input.candidate) },
      };
    }
    const gap = citationGap(candidate, evidenceIds, untestable);
    if (gap !== null) return { next: record, value: { refusal: gap } };
    const finding: Finding = {
      id: `f${record.findings.length + 1}`,
      verdict: input.verdict,
      candidate: input.candidate,
      explanation: input.explanation,
      evidenceIds,
      recordedAt: new Date().toISOString(),
    };
    const next = { ...record, findings: [...record.findings, finding] };
    return {
      next,
      value: { id: finding.id, open: openCandidateIds(next) },
    };
  });
  if ("refusal" in outcome) {
    return { recorded: false, message: outcome.refusal };
  }
  publishReportUpdated(sessionId);
  // The state the call produced, so the next move needs no second call to find.
  const remaining =
    outcome.open.length === 0
      ? "Every candidate is settled."
      : `Still open: ${outcome.open.join(", ")}.`;
  return {
    recorded: true,
    message: `Recorded ${outcome.id} about ${input.candidate} as "${input.verdict}". ${remaining}`,
  };
}

interface ComposeReportInput {
  headline: string;
  affected: string;
  summary: string;
  timeline: TimelineEntry[];
  impact: string;
  recommendation: string;
}

// The ISO instants a result carries, listed back so a refusal shows what the
// entry could have copied instead of the time it guessed.
const TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
function instantsIn(result: string): string[] {
  return [...new Set(result.match(TIMESTAMP) ?? [])].slice(0, 8);
}

// The time an entry claims must appear, to the second, in the result it cites,
// so a time in the report is one the reader can open and check.
function timelineGap(
  entry: { at: string; what: string; evidenceId?: string },
  byEvidence: Map<string, ToolCall>,
): string | null {
  if (entry.evidenceId === undefined) {
    return `The timeline entry "${entry.what}" needs an evidence id: the id of the tool call whose result carries this time.`;
  }
  const call = byEvidence.get(entry.evidenceId);
  if (call === undefined || call.result === null) {
    return `The timeline entry "${entry.what}" cites ${entry.evidenceId}, which names no result you have read. Cite the call whose result carries this time.`;
  }
  const second = entry.at.slice(0, 19);
  if (
    !call.result.includes(second) &&
    !call.result.includes(second.replace("T", " "))
  ) {
    const held = instantsIn(call.result);
    const shows =
      held.length === 0
        ? "That result carries no timestamp."
        : `That result carries: ${held.join(", ")}.`;
    return `The timeline entry "${entry.what}" is timed ${entry.at}, which does not appear in ${entry.evidenceId}. ${shows} Copy a time from the result you cite, and never guess one.`;
  }
  return null;
}

// Authored once and written whole; a timeline entry whose time or citation does
// not hold up refuses the report rather than landing a time nobody can check.
export async function composeReport(
  sessionId: string,
  input: ComposeReportInput,
): Promise<RecordOutcome> {
  const entries = await toolCallsIn(sessionId);
  const byEvidence = new Map(
    entries.flatMap((e) =>
      e.evidenceId === undefined ? [] : [[e.evidenceId, e]],
    ),
  );
  for (const entry of input.timeline) {
    const gap = timelineGap(entry, byEvidence);
    if (gap !== null) return { recorded: false, message: gap };
  }
  const timeline = input.timeline.map((entry) => ({ ...entry }));
  await amendRecord(sessionId, (record) => ({
    ...record,
    report: {
      headline: input.headline,
      affected: input.affected,
      summary: input.summary,
      timeline,
      impact: input.impact,
      recommendation: input.recommendation,
      submittedAt: new Date().toISOString(),
    },
  }));
  publishReportUpdated(sessionId);
  return { recorded: true, message: "Report recorded." };
}
