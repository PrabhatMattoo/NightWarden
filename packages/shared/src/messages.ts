// A turn is kept as parts alone. Whatever a provider needs handed back verbatim
// rides on the part it belongs to, under that provider's own name.

import type { RecordGapKind } from "./reports.js";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | Readonly<JsonObject>
  | readonly JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

// Keyed by provider, so a part replayed into a different one carries nothing
// that provider recognises and is dropped rather than sent wrong.
export type PartProviderOptions = Record<string, JsonObject>;

export interface TextPart {
  type: "text";
  text: string;
  // The block's ordinal within its turn, stamped as the stream opens it, so a
  // streamed row and its persisted twin key the same and never remount.
  block?: number;
}

// The model's reasoning. Portable as prose, and the signed or encrypted original
// some vendors require back verbatim rides in providerOptions.
export interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerOptions?: PartProviderOptions;
  block?: number;
}

export interface ToolCallPart {
  type: "tool_call";
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  // Reasoning a vendor sealed onto the call rather than a reasoning part, sent back verbatim.
  providerOptions?: PartProviderOptions;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  output: string;
  // Carried by the answer rather than the request, because a call that has not
  // returned shows nothing anyone can cite. Absent on a tool no claim may rest on.
  evidenceId?: string;
  // Whether the tool failed. What it found is the output's own business: a
  // query that matched nothing answers with an empty result and no error.
  isError?: boolean;
  // Present when the harness refused the call, so the run's allowances count
  // refusals from the result rather than from its wording.
  refusal?: ToolRefusal;
}

// A tool this turn was not offered, or a close the record cannot support yet.
export type ToolRefusal =
  | { kind: "unavailable"; tool: string }
  | { kind: "record_gaps"; gaps: RecordGapKind[] };

// The signed-in person who made a human decision, stamped from the request's own
// session so the audit trail names who, not just what. Optional on older parts.
export interface Actor {
  id: string;
  name: string;
  email: string;
}

// Written only where a person was asked to release a write, which is the only
// place approval can be known. A refused call never reached a gate.
export interface ToolApprovalPart {
  type: "tool_approval";
  toolCallId: string;
  approved: boolean;
  reason?: string;
  actor?: Actor;
}

// The answer to an elicitation. Separate from an approval because being asked
// a question and permitting a write are different acts.
export interface ElicitationAnswerPart {
  type: "elicitation_answer";
  toolCallId: string;
  text: string;
  actor?: Actor;
}

/* The summary a provider wrote in place of everything above it, replayed as
   what it stands for. Drawn as a marker, so the text is kept but never shown. */
export interface CompactionPart {
  type: "compaction";
  text: string;
  block?: number;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | ToolApprovalPart
  | ElicitationAnswerPart
  | CompactionPart;

// What the model reads for one result: the stored output stays clean, so the
// transcript card and the report draw the answer without the handle on it.
export function toolResultText(part: ToolResultPart): string {
  return part.evidenceId === undefined
    ? part.output
    : `Evidence ID: ${part.evidenceId}\n${part.output}`;
}

// Human-readable rendering of a turn, for titles and list rows. Tool calls are
// named rather than dumped: the transcript projection is what renders them.
export function messagePartsToText(parts: MessagePart[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push(part.text);
    else if (part.type === "reasoning") out.push(part.text);
    else if (part.type === "tool_call") out.push(`[tool: ${part.name}]`);
    else if (part.type === "tool_result") out.push(part.output);
    // An answer is what the person said; an approval is a decision the card draws.
    else if (part.type === "elicitation_answer") out.push(part.text);
  }
  return out.join("\n");
}
