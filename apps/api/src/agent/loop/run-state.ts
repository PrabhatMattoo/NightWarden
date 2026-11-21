import {
  messagePartsToText,
  type MessagePart,
  type ReminderKind,
  type ResolvedLLMConfig,
  type TranscriptRow,
} from "@nightwarden/shared";
import { resultParts } from "../evidence-id.js";
import { asSystemReminder, stripSystemReminder } from "../system-reminder.js";
import { notRunResult, type OfferedToolset } from "../tools/toolset.js";
import { toProviderMessage } from "../../session/seed.js";
import {
  appendRowsAndPark,
  appendTranscriptRows,
} from "../../session/transcript-store.js";
import { publishMessage } from "../../session/stream.js";
import type { PendingHumanInput } from "../../session/gate-store.js";
import { logger } from "../../logger.js";
import type {
  ChatResponse,
  ProviderMessage,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "../../llm/types.js";
import { citableIds, RunPosition } from "./guardrails.js";

// A thrown error is the fourth state, "failed", and the dispatcher's catch
// owns it: it is never returned here.
export type RunOutcome = "completed" | "suspended" | "stopped";

// One chat call with the run's provider bound in: the driver supplies it so the
// turn cycle never sees the provider or the retry policy.
type ChatFn = (
  messages: readonly ProviderMessage[],
  tools: ToolSchema[],
  turn: number,
  signal?: AbortSignal,
) => Promise<ChatResponse>;

/* The transcript this run is building, and the operations over it. The rows are
   kept in memory and the tail past `flushed` is what reaches disk. */
export class RunState {
  readonly rows: TranscriptRow[] = [];
  private flushed = 0;
  nextSeq: number;
  nextEvidence: number;
  // Set before the first turn and re-read each turn as integrations connect.
  offered!: OfferedToolset;
  turn = 0;
  // Folded from the stored rows, then fed every row this run writes.
  readonly position: RunPosition;

  constructor(
    readonly sessionId: string,
    nextSeq: number,
    nextEvidence: number,
    // Read-only prefix already on disk, ahead of what this run appends.
    private readonly seeded: readonly ProviderMessage[],
    // The durable transcript before this run, dead exchanges unwound.
    priorRows: readonly TranscriptRow[] = [],
  ) {
    this.nextSeq = nextSeq;
    this.nextEvidence = nextEvidence;
    this.position = RunPosition.of(priorRows);
  }

  // A harness row is written only by sendSystemReminder, which names its kind.
  enqueue(
    kind: Exclude<TranscriptRow["kind"], "system_reminder">,
    parts: MessagePart[],
    clientId?: string,
  ): void {
    this.push(kind, parts, { ...(clientId !== undefined && { clientId }) });
  }

  private push(
    kind: TranscriptRow["kind"],
    parts: MessagePart[],
    extra: Pick<TranscriptRow, "clientId" | "reminder">,
  ): void {
    const row: TranscriptRow = {
      sessionId: this.sessionId,
      seq: this.nextSeq++,
      kind,
      content: messagePartsToText(parts),
      parts,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    this.rows.push(row);
    this.position.apply(row);
  }

  conversation(): ProviderMessage[] {
    return [...this.seeded, ...this.rows.map(toProviderMessage)];
  }

  flush(interrupt?: PendingHumanInput): void {
    const unwritten = this.rows.slice(this.flushed);
    if (unwritten.length === 0 && interrupt === undefined) return;
    this.flushed = this.rows.length;
    if (interrupt) appendRowsAndPark(unwritten, interrupt);
    else appendTranscriptRows(unwritten);
    // A harness row draws nothing, so publishing it costs a refetch that
    // changes no pixel.
    for (const row of unwritten) {
      if (row.kind !== "system_reminder") publishMessage(this.sessionId, row);
    }
  }

  // The counter advances with the evidence rather than with the request, so a
  // call made in this reply has no handle until its answer arrives.
  stageResults(uses: readonly ToolUse[], results: readonly ToolResult[]): void {
    const stamped = resultParts(results, citableIds(uses), this.nextEvidence);
    this.nextEvidence = stamped.next;
    this.enqueue("user", stamped.parts);
  }

  // A stopped turn answers every call it made, so none is left without a result.
  stageStopped(uses: readonly ToolUse[], results: readonly ToolResult[]): void {
    if (uses.length === 0) return;
    const answered = new Map(results.map((r) => [r.toolCallId, r]));
    this.stageResults(
      uses,
      uses.map((use) => answered.get(use.toolCallId) ?? notRunResult(use)),
    );
  }

  // The one emitter of the tag, so also the door untrusted text arrives at:
  // an injected alert's labels are the sender's and must not close our tag.
  sendSystemReminder(reminder: ReminderKind, text: string): void {
    this.push(
      "system_reminder",
      [{ type: "text", text: asSystemReminder(stripSystemReminder(text)) }],
      { reminder },
    );
  }
}

// What the driver hands the turn cycle: the run's fixed facts and the bound chat
// call. The state above carries the rest, its position included.
export interface RunContext {
  readonly state: RunState;
  readonly sessionId: string;
  // The user's stop.
  readonly signal: AbortSignal | undefined;
  // The user's stop combined with the investigation deadline.
  readonly runSignal: AbortSignal;
  readonly outOfTime: AbortSignal;
  readonly deadline: number;
  readonly log: typeof logger;
  readonly opensInvestigation: boolean;
  // Writes a human already approved, constant for a run: a new approval only ever
  // lands across a resume, so it is counted once at start rather than per turn.
  readonly approvedWrites: number;
  readonly llm: ResolvedLLMConfig;
  readonly toolCallCeilingMs: number;
  readonly chat: ChatFn;
}

/* What one turn tells the driver to do next: loop again, break to the
   continue-request, or end the run with this outcome. */
export type TurnResult =
  | { kind: "continue" }
  | { kind: "budget" }
  // The record is short of a verdict the run will not supply, so it closes on a
  // turn addressed to the reader rather than on a write-up it cannot support.
  | { kind: "stand_down" }
  | { kind: "outcome"; outcome: RunOutcome };
