// A session is the agent's conversation thread (the durable parent); an incident is an optional
// artifact referencing it. Sessions live in the API's SQLite, id generated at trigger time, appended per turn.

import type { MessagePart } from "./messages.js";
import type { InvestigationStatus } from "./schemas/sessions.js";

// Four kinds against a provider's two roles: "error" is rendered but never
// replayed, "system_reminder" replayed but never rendered. buildSeed maps them.
export type TranscriptKind = "user" | "assistant" | "error" | "system_reminder";

// Which note a system_reminder row is. The run's position is folded from these,
// never from the prose the note carried.
export type ReminderKind =
  | "alert_opening"
  | "candidates_opening"
  | "frontier"
  | "falsification"
  | "report_request"
  | "report_retry"
  | "closing"
  | "text_only"
  | "reopen"
  | "record_check"
  | "toolset_change"
  | "injected_alerts"
  | "sandbox_ready";

// Whether a failed run is retried automatically or waits for a person.
export type FailureKind = "transient" | "permanent";

// Which gate a parked session waits on.
export type AwaitingKind = "approval" | "clarification" | "continue";

// The Investigations page's views beside All: what is still in play, what
// recovered, and what ended without the alert clearing.
export type StatusFilter = "active" | "resolved" | "closed";

export const STATUS_FILTERS: readonly StatusFilter[] = [
  "active",
  "resolved",
  "closed",
];

// The stored statuses each view gathers, read by the server's query and the page alike.
export const FILTER_STATUSES: Record<
  StatusFilter,
  readonly InvestigationStatus[]
> = {
  active: ["action_required", "running", "not_started"],
  resolved: ["resolved"],
  closed: ["completed", "stopped", "failed"],
};

// Two pages over one table. Without it a page of results can be entirely the
// other kind, and pagination stops meaning anything.
export type SessionKind = "investigation" | "chat";

// One row of a session's transcript. Most are conversation turns; some are not,
// which is what `kind` answers.
export interface TranscriptRow {
  sessionId: string;
  seq: number;
  kind: TranscriptKind;
  // Human-readable rendering, derived from parts. Titles and list rows read it.
  content: string;
  // The turn's portable content. Empty on "error" rows, which are our own notes
  // rather than a model turn.
  parts: MessagePart[];
  timestamp: string;
  // The id the sender minted for a person's message; beside the parts, so it is
  // never replayed to the model.
  clientId?: string;
  // Present on every system_reminder row and on no other kind.
  reminder?: ReminderKind;
}
