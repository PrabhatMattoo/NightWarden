/* Where a run stands, folded from its transcript a row at a time, and the limits
   read off it. A live run and a resumed one apply the same rows, so they agree. */

import type {
  RecordGapKind,
  ReminderKind,
  TranscriptRow,
} from "@nightwarden/shared";
import { isCitable } from "../report.js";
import { recordCheck } from "../prompts/report.js";
import { offeredSchemas, type OfferedToolset } from "../tools/toolset.js";
import type { ToolUse } from "../../llm/types.js";

// Per gap kind, so a run stuck on one gap cannot spend another gap's allowance.
const MAX_FINISH_PUSHBACKS = 3;

// Turns that asked for no tool at all: enough to tell a model pausing from one
// that will not call CloseInvestigation.
const MAX_CLOSE_PROMPTS = 3;

// The deliverable is worth several tries, and a model that will not call the
// tool cannot be made to.
const MAX_REPORT_ATTEMPTS = 5;

// Consecutive turns of nothing but unavailable tools: a wrong guess, or nothing left to try.
const MAX_BARREN_TURNS = 3;

// Past orientation and long before the budget matters: the run has read a lot
// and settled none of it.
const READS_BEFORE_RECORD_CHECK = 8;
const MAX_RECORD_CHECKS = 3;

// The investigation's progress since it was last reopened.
interface Epoch {
  openingSaid: boolean;
  challengeIssued: boolean;
  // An accepted close after the challenge, which owes the write-up.
  closedAfterChallenge: boolean;
  reportWritten: boolean;
  closingTurnDone: boolean;
  // A candidate or finding landed, so a reopen has work to challenge.
  recordChanged: boolean;
}

// What the run has spent since a person last spoke, when every allowance resets.
interface Spent {
  refusals: Record<RecordGapKind, number>;
  textOnly: number;
  recordChecks: number;
  reportAsks: number;
  readsSinceFinding: number;
  readsSinceCheck: number;
  barrenTurns: number;
  unavailableAsks: Map<string, number>;
}

const freshEpoch = (): Epoch => ({
  openingSaid: false,
  challengeIssued: false,
  closedAfterChallenge: false,
  reportWritten: false,
  closingTurnDone: false,
  recordChanged: false,
});

const freshSpent = (): Spent => ({
  refusals: { empty_record: 0, untested_candidates: 0 },
  textOnly: 0,
  recordChecks: 0,
  reportAsks: 0,
  readsSinceFinding: 0,
  readsSinceCheck: 0,
  barrenTurns: 0,
  unavailableAsks: new Map(),
});

export class RunPosition {
  // The first turn's calls still unanswered; null until it is seen.
  #firstTurnOpen: Set<string> | null = null;
  #firstTurnSettled = false;
  readonly #callNames = new Map<string, string>();
  #epoch = freshEpoch();
  #spent = freshSpent();

  static of(rows: readonly TranscriptRow[]): RunPosition {
    const position = new RunPosition();
    for (const row of rows) position.apply(row);
    return position;
  }

  apply(row: TranscriptRow): void {
    if (row.kind === "system_reminder") this.#reminded(row.reminder);
    if (row.kind === "assistant") this.#called(row);
    if (row.kind === "user") {
      // A message, the finish-up request or a reopen reason. A gate's answer carries no text.
      if (row.parts.some((p) => p.type === "text")) this.#spent = freshSpent();
      this.#answered(row);
    }
  }

  // Session-wide, because a first turn never un-settles.
  get firstTurnSettled(): boolean {
    return this.#firstTurnSettled;
  }
  get openingSaid(): boolean {
    return this.#epoch.openingSaid;
  }
  get challengeIssued(): boolean {
    return this.#epoch.challengeIssued;
  }
  get reportPending(): boolean {
    return this.#epoch.closedAfterChallenge && !this.#epoch.reportWritten;
  }
  get reportWritten(): boolean {
    return this.#epoch.reportWritten;
  }
  get closingTurnDone(): boolean {
    return this.#epoch.closingTurnDone;
  }
  get recordChanged(): boolean {
    return this.#epoch.recordChanged;
  }
  get spent(): Readonly<Spent> {
    return this.#spent;
  }

  #reminded(kind: ReminderKind | undefined): void {
    switch (kind) {
      case "reopen":
        this.#epoch = freshEpoch();
        return;
      case "candidates_opening":
        this.#epoch.openingSaid = true;
        return;
      case "falsification":
        this.#epoch.challengeIssued = true;
        return;
      case "closing":
        this.#epoch.closingTurnDone = true;
        return;
      case "text_only":
        this.#spent.textOnly += 1;
        return;
      case "record_check":
        this.#spent.recordChecks += 1;
        this.#spent.readsSinceCheck = 0;
        return;
      case "report_request":
      case "report_retry":
        this.#spent.reportAsks += 1;
        return;
      default:
        return;
    }
  }

  #called(row: TranscriptRow): void {
    const ids: string[] = [];
    for (const part of row.parts) {
      if (part.type !== "tool_call") continue;
      this.#callNames.set(part.toolCallId, part.name);
      ids.push(part.toolCallId);
    }
    if (this.#firstTurnOpen !== null || this.#firstTurnSettled) return;
    this.#firstTurnOpen = new Set(ids);
    this.#firstTurnSettled = ids.length === 0;
  }

  #answered(row: TranscriptRow): void {
    const results = row.parts.flatMap((p) =>
      p.type === "tool_result" ? [p] : [],
    );
    if (results.length === 0) return;
    const accepted = (name: string): boolean =>
      results.some(
        (r) => r.isError !== true && this.#callNames.get(r.toolCallId) === name,
      );
    // A finding clears the read debt before this turn's reads are counted against it.
    if (accepted("RecordFinding")) {
      this.#spent.readsSinceFinding = 0;
      this.#spent.readsSinceCheck = 0;
    }
    if (accepted("OpenCandidates") || accepted("RecordFinding")) {
      this.#epoch.recordChanged = true;
    }
    if (accepted("CloseInvestigation") && this.#epoch.challengeIssued) {
      this.#epoch.closedAfterChallenge = true;
    }
    if (accepted("ComposeReport")) this.#epoch.reportWritten = true;

    let unavailable = 0;
    for (const result of results) {
      this.#firstTurnOpen?.delete(result.toolCallId);
      // Stamped only on a citable answer, so it counts exactly the reads that could back a claim.
      if (result.evidenceId !== undefined) {
        this.#spent.readsSinceFinding += 1;
        this.#spent.readsSinceCheck += 1;
      }
      const refusal = result.refusal;
      if (refusal?.kind === "record_gaps") {
        for (const gap of refusal.gaps) this.#spent.refusals[gap] += 1;
      }
      if (refusal?.kind === "unavailable") {
        unavailable += 1;
        const asks = this.#spent.unavailableAsks;
        asks.set(refusal.tool, (asks.get(refusal.tool) ?? 0) + 1);
      }
    }
    if (this.#firstTurnOpen?.size === 0) this.#firstTurnSettled = true;
    this.#spent.barrenTurns =
      unavailable === results.length ? this.#spent.barrenTurns + 1 : 0;
  }
}

// Read after the refusal is applied: the run carries on while any gap it named has pushback left.
export function refusalsSpent(
  position: RunPosition,
  gaps: readonly RecordGapKind[],
): boolean {
  return gaps.every(
    (gap) => position.spent.refusals[gap] > MAX_FINISH_PUSHBACKS,
  );
}

// Whether a silent investigation turn may still be nudged; spent, the run stands down.
export function nudgeLeft(position: RunPosition): boolean {
  return position.spent.textOnly < MAX_CLOSE_PROMPTS;
}

// The first ask is the full request and the rest are retries; null once spent.
export function reportAsk(position: RunPosition): "request" | "retry" | null {
  const asks = position.spent.reportAsks;
  if (asks >= MAX_REPORT_ATTEMPTS) return null;
  return asks === 0 ? "request" : "retry";
}

/* A turn of nothing but unavailable tools gets nothing done, and the model cannot
   see it is looping. The toolset rides in because the ending names it. */
export function barrenEnding(
  position: RunPosition,
  offered: OfferedToolset,
): string | null {
  const barren = position.spent.barrenTurns;
  if (barren < MAX_BARREN_TURNS) return null;
  return `The last ${barren} turns asked only for tools this investigation does not have, so the run was ended rather than spend its budget repeating them. What was available: ${offeredSchemas(
    offered,
  )
    .map((t) => t.name)
    .join(", ")}.`;
}

// Asks again after another eight reads rather than every turn, and only so often.
export function recordCheckDue(
  position: RunPosition,
  investigation: boolean,
): string | null {
  const { recordChecks, readsSinceCheck, readsSinceFinding } = position.spent;
  if (!investigation || recordChecks >= MAX_RECORD_CHECKS) return null;
  if (readsSinceCheck < READS_BEFORE_RECORD_CHECK) return null;
  return recordCheck(readsSinceFinding);
}

// Read from the turn, because a harness turn orphans a tool_use from its result.
export function citableIds(uses: readonly ToolUse[]): Set<string> {
  return new Set(
    uses.filter((t) => isCitable(t.name)).map((t) => t.toolCallId),
  );
}
