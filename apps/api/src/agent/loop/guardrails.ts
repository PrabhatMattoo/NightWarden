import type { TranscriptRow } from "@nightwarden/shared";
import { isCitable, type RecordGap } from "../report.js";
import { highestEvidenceNumber } from "../evidence-id.js";
import {
  CLOSING_MESSAGE,
  FALSIFICATION_MESSAGE,
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

// Pending: closed after the challenge but no ComposeReport landed yet. A report
// already written is not restored - a follow-up re-earns it with a fresh close.
function reportPending(rows: readonly TranscriptRow[]): boolean {
  const accepted = new Set<string>();
  for (const row of rows)
    for (const part of row.parts)
      if (part.type === "tool_result" && part.isError !== true)
        accepted.add(part.toolCallId);
  let challenged = false;
  let closedAfterChallenge = false;
  for (const row of rows) {
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

// The four phase milestones this session has passed. Read once from the durable
// transcript on resume; the live run keeps them in memory as each event lands.
export interface RunProgress {
  evidenceGathered: boolean;
  challengeIssued: boolean;
  reportUnlocked: boolean;
  closingTurnDone: boolean;
}

export function deriveRunProgress(rows: readonly TranscriptRow[]): RunProgress {
  return {
    evidenceGathered: highestEvidenceNumber(rows) > 0,
    challengeIssued: spentOn(rows, FALSIFICATION_MESSAGE) > 0,
    reportUnlocked: reportPending(rows),
    closingTurnDone: spentOn(rows, CLOSING_MESSAGE) > 0,
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
