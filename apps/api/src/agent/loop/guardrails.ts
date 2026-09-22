import type { TranscriptRow } from "@nightwarden/shared";
import { isCitable, type RecordGap } from "../report.js";
import {
  CANDIDATES_OPENING_MESSAGE,
  CLOSING_MESSAGE,
  FALSIFICATION_MESSAGE,
  REOPEN_PREFIX,
  TEXT_ONLY_PREFIX,
  recordGapsMessage,
  recordCheck,
} from "../prompts/report.js";
import { offeredSchemas, type OfferedToolset } from "../tools/toolset.js";
import type { ToolResult, ToolUse } from "../../llm/types.js";

// Per gap kind, so a run stuck on one gap cannot spend another gap's allowance.
// The time budget bounds it as well.
const MAX_FINISH_PUSHBACKS = 3;

// Null once the kind's cap is spent, which writes the report up incomplete.
export type FinishGate = (gaps: RecordGap[]) => {
  say: string;
  kind: RecordGap["kind"];
  count: number;
} | null;

export function finishGatePolicy(
  spent: Record<RecordGap["kind"], number>,
): FinishGate {
  const counts: Record<RecordGap["kind"], number> = { ...spent };
  return (gaps) => {
    for (const gap of gaps) {
      if (counts[gap.kind] >= MAX_FINISH_PUSHBACKS) continue;
      counts[gap.kind] += 1;
      return {
        say: recordGapsMessage([gap]),
        kind: gap.kind,
        count: counts[gap.kind],
      };
    }
    return null;
  };
}

// Investigation turns that asked for no tool at all. Three is enough to tell a
// model pausing from one that will not call CloseInvestigation at all.
const MAX_CLOSE_PROMPTS = 3;

/* Null once spent, which stands the run down: a model that will not call
   CloseInvestigation cannot be made to, and the record is what it is. */
export type ClosePrompts = () => boolean;

export function closePromptPolicy(spent: number): ClosePrompts {
  let sent = spent;
  return () => {
    if (sent >= MAX_CLOSE_PROMPTS) return false;
    sent += 1;
    return true;
  };
}

/* Attempts at the write-up. Matching the close allowance: the deliverable is
   worth several tries, and a model that will not call the tool cannot be made to. */
const MAX_REPORT_ATTEMPTS = 5;

/* The attempt this turn is, or null once spent - which ends the run with the
   record and no write-up. The number says whether to ask in full or to nudge. */
export type ReportAttempts = () => number | null;

export function reportAttemptPolicy(spent: number): ReportAttempts {
  let made = spent;
  return () => {
    if (made >= MAX_REPORT_ATTEMPTS) return null;
    made += 1;
    return made;
  };
}

// Consecutive turns that asked for nothing but unavailable tools. Three is
// enough to tell a wrong guess from a model with nothing left to try.
const MAX_BARREN_TURNS = 3;

// The toolset rides in because it changes mid-run and the ending names it.
export type BarrenTurns = (
  asked: number,
  refused: number,
  offered: OfferedToolset,
) => string | null;

/* A turn of nothing but unavailable tools gets nothing done, and the model
   cannot see it is looping, so only the time budget would stop it. */
export function barrenTurnPolicy(): BarrenTurns {
  let barren = 0;
  return (asked, refused, offered) => {
    barren = refused === asked ? barren + 1 : 0;
    if (barren < MAX_BARREN_TURNS) return null;
    return `The last ${barren} turns asked only for tools this investigation does not have, so the run was ended rather than spend its budget repeating them. What was available: ${offeredSchemas(
      offered,
    )
      .map((t) => t.name)
      .join(", ")}.`;
  };
}

// Past orientation and long before the budget matters. A check, not a repair:
// nothing has failed, the run has simply read a lot and settled none of it.
const CALLS_BEFORE_RECORD_CHECK = 8;

// Every check is a durable row the seed replays, so a run that never records
// is bounded rather than asked for the rest of it.
const MAX_RECORD_CHECKS = 3;

export interface RecordDebt {
  // Takes the record's own claim count, so a claim recorded this turn clears
  // the debt before this turn's reads are counted against it.
  check: (claims: number, answered: number) => string | null;
}

/* Recording is what clears the debt, so a run that settles something early and
   then reads on is asked again. */
export function recordDebtPolicy(
  investigation: boolean,
  spent: number,
): RecordDebt {
  let sinceClaim = 0;
  let claimsSeen = 0;
  // The debt when the check last spoke, so it asks again after another eight
  // rather than every turn.
  let checkedAt = 0;
  let checks = spent;
  return {
    check: (claims, answered) => {
      if (claims > claimsSeen) {
        claimsSeen = claims;
        sinceClaim = 0;
        checkedAt = 0;
      }
      sinceClaim += answered;
      if (!investigation || checks >= MAX_RECORD_CHECKS) return null;
      if (sinceClaim - checkedAt < CALLS_BEFORE_RECORD_CHECK) return null;
      checks++;
      checkedAt = sinceClaim;
      return recordCheck(sinceClaim);
    },
  };
}

// What earlier runs on this session already spent, read off the turns they sent.
export function spentOn(
  rows: readonly TranscriptRow[],
  opening: string,
): number {
  return rows.filter(
    (r) => r.kind === "system_reminder" && r.content.includes(opening),
  ).length;
}

// A reopen starts its own epoch: every stage fact reads only the rows after it.
function epochRows(rows: readonly TranscriptRow[]): readonly TranscriptRow[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "system_reminder" && row.content.includes(REOPEN_PREFIX)) {
      return rows.slice(i);
    }
  }
  return rows;
}

// Session-wide, because a first turn never un-settles: a resumed run reads it.
function firstTurnSettled(rows: readonly TranscriptRow[]): boolean {
  const first = rows.find((r) => r.kind === "assistant");
  if (first === undefined) return false;
  const called = first.parts.flatMap((p) =>
    p.type === "tool_call" ? [p.toolCallId] : [],
  );
  if (called.length === 0) return true;
  const answered = new Set(
    rows.flatMap((r) =>
      r.parts.flatMap((p) => (p.type === "tool_result" ? [p.toolCallId] : [])),
    ),
  );
  return called.every((id) => answered.has(id));
}

// An accepted close after this epoch's challenge, with no write-up landed since.
function reportPending(epoch: readonly TranscriptRow[]): boolean {
  const accepted = new Set<string>();
  for (const row of epoch)
    for (const part of row.parts)
      if (part.type === "tool_result" && part.isError !== true)
        accepted.add(part.toolCallId);
  let challenged = false;
  let closedAfterChallenge = false;
  for (const row of epoch) {
    if (
      row.kind === "system_reminder" &&
      row.content.includes(FALSIFICATION_MESSAGE)
    ) {
      challenged = true;
      continue;
    }
    for (const part of row.parts) {
      if (part.type !== "tool_call" || !accepted.has(part.toolCallId)) continue;
      if (part.name === "ComposeReport") return false;
      if (challenged && part.name === "CloseInvestigation")
        closedAfterChallenge = true;
    }
  }
  return closedAfterChallenge;
}

// A candidate or finding landed in this epoch, so a reopen has work to challenge.
function recordChanged(epoch: readonly TranscriptRow[]): boolean {
  const names = new Map<string, string>();
  for (const row of epoch)
    for (const part of row.parts)
      if (part.type === "tool_call") names.set(part.toolCallId, part.name);
  return epoch.some((row) =>
    row.parts.some(
      (part) =>
        part.type === "tool_result" &&
        part.isError !== true &&
        (names.get(part.toolCallId) === "OpenCandidates" ||
          names.get(part.toolCallId) === "RecordFinding"),
    ),
  );
}

// A write-up landed in this epoch: the goodbye turn runs only after one.
function reportWritten(epoch: readonly TranscriptRow[]): boolean {
  const answered = new Set(
    epoch.flatMap((row) =>
      row.parts.flatMap((p) =>
        p.type === "tool_result" && p.isError !== true ? [p.toolCallId] : [],
      ),
    ),
  );
  return epoch.some((row) =>
    row.parts.some(
      (part) =>
        part.type === "tool_call" &&
        part.name === "ComposeReport" &&
        answered.has(part.toolCallId),
    ),
  );
}

// The stage facts, derived from the transcript each turn and on resume alike, so
// the live run and a resumed one read the same view.
export interface RunProgress {
  firstTurnSettled: boolean;
  openingSaid: boolean;
  challengeIssued: boolean;
  reportPending: boolean;
  reportWritten: boolean;
  closingTurnDone: boolean;
  recordChanged: boolean;
  textOnlySpent: number;
}

export function deriveRunProgress(rows: readonly TranscriptRow[]): RunProgress {
  const epoch = epochRows(rows);
  const said = (opening: string): boolean =>
    epoch.some(
      (r) => r.kind === "system_reminder" && r.content.includes(opening),
    );
  return {
    firstTurnSettled: firstTurnSettled(rows),
    openingSaid: said(CANDIDATES_OPENING_MESSAGE),
    challengeIssued: said(FALSIFICATION_MESSAGE),
    reportPending: reportPending(epoch),
    reportWritten: reportWritten(epoch),
    closingTurnDone: said(CLOSING_MESSAGE),
    recordChanged: recordChanged(epoch),
    textOnlySpent: spentOn(epoch, TEXT_ONLY_PREFIX),
  };
}

// Read from the turn, because a harness turn orphans a tool_use from its result.
export function citableIds(uses: readonly ToolUse[]): Set<string> {
  return new Set(
    uses.filter((t) => isCitable(t.name)).map((t) => t.toolCallId),
  );
}

// Calls that answered and could back a claim; a refused one taught nothing.
export function citableAnswers(
  uses: readonly ToolUse[],
  results: readonly ToolResult[],
): number {
  const citable = citableIds(uses);
  return results.filter((r) => r.isError !== true && citable.has(r.toolCallId))
    .length;
}
