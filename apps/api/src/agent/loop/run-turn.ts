import { METRICS_SOURCE_KINDS, openCandidateIds } from "@nightwarden/shared";
import type {
  InvestigationRecord,
  ReportCardItem,
  ToolName,
} from "@nightwarden/shared";
import type { ToolDispatchContext } from "../tools/types.js";
import {
  effectiveToolset,
  offeredSchemas,
  type OfferedToolset,
} from "../tools/toolset.js";
import { connectedPlatforms } from "../policy.js";
import { connectedKinds } from "../../integrations/store.js";
import { getRecord } from "../../session/record-store.js";
import { recoveryState } from "../../verification/recovery.js";
import {
  approvedWriteCount,
  gatedCalls,
  openCandidateRows,
  toolCallsIn,
} from "../report.js";
import {
  CANDIDATES_OPENING_MESSAGE,
  closingMessage,
  falsificationMessage,
  frontierMessage,
  REPORT_RETRY_MESSAGE,
  reportRequest,
  textOnlyReplyMessage,
} from "../prompts/report.js";
import { appendErrorMessage } from "../../session/transcript-store.js";
import {
  markAlertsDelivered,
  pendingAlerts,
} from "../../session/alerts-store.js";
import {
  publishInterrupt,
  publishTranscriptItem,
} from "../../session/stream.js";
import { toolCallCard } from "../../session/transcript.js";
import type { PendingHumanInput } from "../../session/gate-store.js";
import type { ChatResponse, ToolResult, ToolUse } from "../../llm/types.js";
import { COMPOSE_REPORT_TOOL } from "../tools/report.js";
import { processToolUses } from "./turn.js";
import { REPORT_GIVEN_UP, reportEnding, turnEnding } from "./endings.js";
import {
  barrenEnding,
  nudgeLeft,
  recordCheckDue,
  refusalsSpent,
  reportAsk,
  type RunPosition,
} from "./guardrails.js";
import { takeSandboxNote } from "../../sandbox/workspace.js";
import { formatInjectedAlerts } from "./injection.js";
import type { RunContext, TurnResult } from "./run-state.js";

// What the fleet and the connected integrations currently allow. Read together,
// because the prompt describing them is built from the same call.
export function currentToolset(investigation: boolean): OfferedToolset {
  const kinds = connectedKinds();
  return effectiveToolset(
    connectedPlatforms(),
    {
      github: kinds.has("github"),
      metrics: METRICS_SOURCE_KINDS.some((k) => kinds.has(k)),
      loki: kinds.has("loki"),
      sentry: kinds.has("sentry"),
    },
    investigation,
  );
}

// Names only the difference: a run thirty turns deep does not need its whole
// toolset restated, and each tool already carries its own description.
function toolsetChange(
  before: OfferedToolset,
  after: OfferedToolset,
): string | null {
  const was = new Set(before.tools.map((t) => t.schema.name));
  const now = new Set(after.tools.map((t) => t.schema.name));
  const gained = [...now].filter((n) => !was.has(n));
  const lost = [...was].filter((n) => !now.has(n));
  if (gained.length === 0 && lost.length === 0) return null;
  const lines: string[] = [];
  if (gained.length > 0) {
    lines.push(
      `Something connected while you were working, so these tools are available to you now: ${gained.join(", ")}.`,
    );
  }
  if (lost.length > 0) {
    lines.push(
      `Something disconnected while you were working, so these tools are no longer available and calling one will be refused: ${lost.join(", ")}. Anything they already told you stays on the record.`,
    );
  }
  return lines.join(" ");
}

type Gate = { tool: ToolUse; kind: "approval" | "clarification" };

// Durably suspend on a gated call: persist the assistant turn and the interrupt
// row in one transaction, then tell the frontend a human is needed.
function suspendOnGate(
  ctx: RunContext,
  gated: Gate,
  toolResults: ToolResult[],
): void {
  const { sessionId, log } = ctx;
  const isAskGate = gated.kind === "clarification";
  const interrupt: PendingHumanInput = {
    sessionId,
    toolCallId: gated.tool.toolCallId,
    kind: isAskGate ? "clarification" : "approval",
    completedResults: toolResults,
    claimedAt: null,
  };
  ctx.state.flush(interrupt);
  const clarInput = isAskGate
    ? (gated.tool.input as {
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: boolean;
      })
    : null;
  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolCallId: gated.tool.toolCallId,
      toolName: gated.tool.name,
      input: gated.tool.input,
      state: {
        phase: "awaiting_human",
        gate: isAskGate ? "clarification" : "approval",
      },
    }),
  });
  publishInterrupt({
    sessionId,
    toolCallId: gated.tool.toolCallId,
    toolName: gated.tool.name,
    input: gated.tool.input,
    kind: isAskGate ? "clarification" : "approval",
    ...(clarInput !== null && {
      question: clarInput.question,
      options: clarInput.options,
      multiSelect: clarInput.multiSelect,
    }),
  });
  log.info(
    { tool: gated.tool.name, kind: interrupt.kind },
    "run suspended: pending human input",
  );
}

/* Keeps the open candidates in view whenever a turn changes the set, so the ones
   still to test are not lost behind a long chain of reads. */
function emitFrontierIfChanged(
  ctx: RunContext,
  before: InvestigationRecord | undefined,
  after: InvestigationRecord | undefined,
): void {
  if (after === undefined) return;
  const was = before === undefined ? [] : openCandidateIds(before);
  const open = openCandidateIds(after);
  const same =
    open.length === was.length && open.every((id) => was.includes(id));
  if (!same && open.length > 0)
    ctx.state.sendSystemReminder("frontier", frontierMessage(after));
}

/* The record's own tools, withheld until the phase that needs each. A chat is
   offered none of them, so its phase is always the whole of what it was given. */
const RECORD_TOOL_NAMES: readonly ToolName[] = [
  "OpenCandidates",
  "RecordFinding",
  "CloseInvestigation",
];

type Stage =
  | "conversation"
  | "gathering"
  | "opening"
  | "testing"
  | "falsifying"
  | "writingReport"
  | "closingTurn"
  | "closed";

/* Read off the record and the run's position, so a resumed or reopened run lands
   where the investigation stands. */
function stageOf(
  ctx: RunContext,
  progress: RunPosition,
  record: InvestigationRecord | undefined,
): Stage {
  if (!ctx.opensInvestigation) return "conversation";
  if (record !== undefined && record.report !== null) {
    if (progress.reportWritten && progress.closingTurnDone) return "closed";
    // The write-up landed this epoch, so the one thing left is to say so.
    if (progress.reportWritten && !progress.closingTurnDone)
      return "closingTurn";
  }
  if (progress.reportPending) return "writingReport";
  if (!progress.firstTurnSettled) return "gathering";
  if (record === undefined || record.candidates.length === 0) return "opening";
  if (progress.challengeIssued && openCandidateIds(record).length === 0)
    return "falsifying";
  return "testing";
}

/* One set both shown to the model and executed from, so a turn cannot be offered
   what it cannot run; a tool the stage withholds is not on the turn. */
function toolsForStage(stage: Stage, offered: OfferedToolset): OfferedToolset {
  const keep = (names: (name: ToolName) => boolean): OfferedToolset => ({
    tools: offered.tools.filter((tool) => names(tool.schema.name)),
    elicitations: offered.elicitations,
  });
  switch (stage) {
    // Before candidates exist, and after the investigation closes, the record's
    // tools stay with the machinery: nothing is there to settle either way.
    case "conversation":
    case "closed":
    case "gathering":
      return keep((name) => !RECORD_TOOL_NAMES.includes(name));
    case "opening":
      return keep((name) => name === "OpenCandidates");
    // CloseInvestigation is falsification's door alone, so testing withholds it.
    case "testing":
      return keep((name) => name !== "CloseInvestigation");
    case "falsifying":
      return offered;
    /* The write-up is composed from the record, and asking a human is already
       settled by the time it runs, so neither is on the turn. */
    case "writingReport":
      return { tools: [COMPOSE_REPORT_TOOL], elicitations: [] };
    case "closingTurn":
      return { tools: [], elicitations: [] };
  }
}

/* The challenge goes out when every candidate is settled and this epoch has
   work behind it, so a close never carries it. */
function emitChallengeIfDue(
  ctx: RunContext,
  progress: RunPosition,
  record: InvestigationRecord | undefined,
): void {
  if (progress.challengeIssued) return;
  if (record === undefined || record.candidates.length === 0) return;
  if (openCandidateIds(record).length > 0) return;
  if (!progress.recordChanged) return;
  ctx.state.sendSystemReminder("falsification", falsificationMessage(record));
}

// One id, because a session has one report: a later phase replaces the card
// rather than stacking a second one under the first.
function publishReportCard(
  sessionId: string,
  phase: ReportCardItem["state"]["phase"],
  headline?: string,
): void {
  publishTranscriptItem({
    sessionId,
    item: {
      kind: "report_card",
      id: "report",
      state: { phase },
      ...(headline !== undefined && { headline }),
    },
  });
}

/* Everything the write-up turn is told, assembled from the record and the
   transcript it is about to describe. */
function writeUpRequest(ctx: RunContext): string {
  const record = getRecord(ctx.sessionId);
  const gated = gatedCalls(toolCallsIn(ctx.sessionId));
  /* Only a run that acted must recommend: ruling things out is a complete
     ending, but releasing a write and going quiet leaves the user nothing. */
  const unrecovered =
    approvedWriteCount(gated) > 0 &&
    recoveryState(ctx.sessionId) === "unconfirmed";
  return reportRequest(
    record?.findings ?? [],
    gated,
    unrecovered,
    /* So a follow-up revises what a previous run wrote rather than rebuilding it
       from a context that may since have been compacted. */
    record?.report ?? null,
  );
}

// One turn of the loop: send the conversation, read what came back, and tell the
// driver to loop, break to the continue-request, or end with an outcome.
export async function runOneTurn(ctx: RunContext): Promise<TurnResult> {
  const { state, sessionId, log, llm } = ctx;
  const turn = (state.turn += 1);

  // Re-read per turn, but never silently: a change the model is not told about
  // looks to it like the rules moved, and the prompt is never revised.
  const nowOffered = currentToolset(ctx.opensInvestigation);
  const change = toolsetChange(state.offered, nowOffered);
  if (change !== null) {
    log.info({ turn, change }, "offered toolset changed mid-run");
    state.offered = nowOffered;
    state.sendSystemReminder("toolset_change", change);
    state.flush();
  }

  // Read once before any tool runs: the challenge and the stage both decide from
  // this snapshot, which no tool has moved yet.
  const recordBefore = getRecord(sessionId);
  /* The challenge precedes the stage it opens, so a close lands inside it. The
     position takes the challenge as it is written, so the stage below sees it. */
  const progress = state.position;
  emitChallengeIfDue(ctx, progress, recordBefore);
  const stage = stageOf(ctx, progress, recordBefore);
  /* Each stage says what it wants before it offers the tools to answer with, so
     the ask and the toolset that serves it are decided in one place. */
  if (stage === "opening" && !progress.openingSaid) {
    state.sendSystemReminder("candidates_opening", CANDIDATES_OPENING_MESSAGE);
  } else if (stage === "writingReport") {
    const ask = reportAsk(progress);
    if (ask === null) {
      log.warn({ turn }, "write-up not written within its attempts");
      appendErrorMessage(sessionId, REPORT_GIVEN_UP);
      publishReportCard(sessionId, "failed");
      return { kind: "outcome", outcome: "completed" };
    }
    publishReportCard(sessionId, "building");
    if (ask === "request") {
      state.sendSystemReminder("report_request", writeUpRequest(ctx));
    } else {
      state.sendSystemReminder("report_retry", REPORT_RETRY_MESSAGE);
    }
  } else if (stage === "closingTurn") {
    if (recordBefore === undefined)
      return { kind: "outcome", outcome: "completed" };
    state.sendSystemReminder("closing", closingMessage(recordBefore));
  }
  state.flush();
  const forThisStage = toolsForStage(stage, state.offered);
  const toolSchemas = offeredSchemas(forThisStage);

  const startedAt = Date.now();
  let response: ChatResponse;
  try {
    response = await ctx.chat(
      state.conversation(),
      toolSchemas,
      state.nextSeq,
      ctx.runSignal,
    );
    state.enqueue("assistant", response.parts);
  } catch (err) {
    if (ctx.signal?.aborted) {
      log.info({ turn }, "run stopped by user");
      state.flush();
      return { kind: "outcome", outcome: "stopped" };
    }
    // The budget cut the turn short. That is the check-in, not a failure, so it
    // leaves the loop rather than killing the run.
    if (ctx.outOfTime.aborted) {
      log.info({ turn }, "time budget reached mid-turn");
      state.flush();
      return { kind: "budget" };
    }
    throw err;
  }
  if (ctx.signal?.aborted) {
    log.info({ turn }, "run stopped by user");
    state.stageStopped(response.toolUses, []);
    state.flush();
    return { kind: "outcome", outcome: "stopped" };
  }
  log.info(
    {
      turn,
      ms: Date.now() - startedAt,
      stopReason: response.stopReason,
      toolUses: response.toolUses.map((t) => t.name),
    },
    "LLM responded",
  );
  state.flush();

  // A lost write-up says so in its own terms; the ending is written to the
  // transcript, since without an error row a nothing turn derives to completed.
  const reportLost =
    stage === "writingReport"
      ? reportEnding(response.stopReason, llm.maxOutputTokens)
      : null;
  /* The record is the half worth keeping, so a lost write-up says so: without it
     the failure reads as though the whole investigation came to nothing. */
  const ending =
    reportLost !== null
      ? `${reportLost} Your findings below are complete.`
      : turnEnding(response.stopReason, llm.maxOutputTokens);
  if (ending !== null) {
    if (reportLost !== null) publishReportCard(sessionId, "failed");
    log.warn(
      { turn, model: llm.model, stopReason: response.stopReason },
      "turn ended without an answer",
    );
    appendErrorMessage(sessionId, ending);
    return { kind: "outcome", outcome: "completed" };
  }

  /* The last stage: the reader has been addressed and there is nothing after it,
     so the run ends here however the model spent the turn. */
  if (stage === "closingTurn") {
    log.info({ turn }, "investigation written up and closed");
    return { kind: "outcome", outcome: "completed" };
  }

  if (response.toolUses.length === 0) {
    // A conversation, open or closed, ends on its own words.
    if (stage === "conversation" || stage === "closed") {
      log.info({ turn }, "conversation finished with free-form response");
      return { kind: "outcome", outcome: "completed" };
    }
    // The first turn asked for nothing, so it is settled and the stage moves on.
    if (stage === "gathering") {
      return { kind: "continue" };
    }
    /* Finishing is an act, so a turn that asked for nothing has not asked to
       finish. Say so, and stand down once the allowance for saying it is spent. */
    if (nudgeLeft(progress)) {
      log.info({ turn }, "investigation turn called no tool; nudging it");
      state.sendSystemReminder(
        "text_only",
        textOnlyReplyMessage(
          stage,
          recordBefore === undefined ? [] : openCandidateRows(recordBefore),
        ),
      );
      state.flush();
      return { kind: "continue" };
    }
    log.warn(
      { turn },
      "investigation never asked to close; standing down without a report",
    );
    return { kind: "stand_down" };
  }

  const execCtx: Omit<ToolDispatchContext, "toolCallId"> = {
    // Already clamped by what remains of the investigation, so no tool call can
    // outlive the budget it is being spent from.
    toolCallCeilingMs: Math.max(
      0,
      Math.min(ctx.toolCallCeilingMs, ctx.deadline - Date.now()),
    ),
    sessionId,
    ...(ctx.signal !== undefined && { stop: ctx.signal }),
  };

  const { toolResults, gated } = await processToolUses({
    toolUses: response.toolUses,
    offered: forThisStage,
    sessionId,
    execCtx,
    log,
    alreadyRefused: progress.spent.unavailableAsks,
  });

  // A turn's tools outlive the stop that arrives during them, so the gate is
  // reached already aborted; suspending here parks an interrupt on a dead run.
  if (ctx.signal?.aborted) {
    log.info({ turn }, "run stopped by user before the gate");
    state.stageStopped(response.toolUses, toolResults);
    state.flush();
    return { kind: "outcome", outcome: "stopped" };
  }

  if (gated !== null) {
    // Alerts joining a parked run stay on their rows until it resumes.
    suspendOnGate(ctx, gated, toolResults);
    return { kind: "outcome", outcome: "suspended" };
  }

  state.stageResults(response.toolUses, toolResults);
  const barren = barrenEnding(progress, state.offered);
  if (barren !== null) {
    log.warn(
      { turn, refused: [...progress.spent.unavailableAsks.keys()] },
      "run asked only for unavailable tools; ending it",
    );
    state.flush();
    appendErrorMessage(sessionId, barren);
    return { kind: "outcome", outcome: "completed" };
  }
  // Read once after the tools ran: the frontier, the card, and the record debt
  // all reflect what this turn just settled.
  const recordAfter = getRecord(sessionId);
  emitFrontierIfChanged(ctx, recordBefore, recordAfter);

  /* The write-up landed, so the card that was spinning now names what it opens.
     A refusal leaves the record behind, which is the next turn's write-up stage. */
  if (stage === "writingReport") {
    const wrote = response.toolUses.some(
      (use) =>
        use.name === "ComposeReport" &&
        toolResults.some(
          (result) =>
            result.toolCallId === use.toolCallId && result.isError !== true,
        ),
    );
    if (wrote) {
      publishReportCard(sessionId, "ready", recordAfter?.report?.headline);
    }
  }

  /* A close only executes in falsification; anywhere else the turn already
     answered it as unoffered, and standing the run down would be a lie. */
  const closing =
    stage === "falsifying"
      ? response.toolUses.find((use) => use.name === "CloseInvestigation")
      : undefined;
  if (closing !== undefined) {
    const answer = toolResults.find(
      (result) => result.toolCallId === closing.toolCallId,
    );
    // An accepted close moves the stage next turn; a refusal already counted
    // against its allowance, and once that is spent the run stands down.
    const refusal = answer?.refusal;
    if (refusal?.kind === "record_gaps") {
      if (refusalsSpent(progress, refusal.gaps)) {
        log.warn({ turn }, "close refused past its allowance; standing down");
        state.flush();
        return { kind: "stand_down" };
      }
      log.info({ turn, gaps: refusal.gaps }, "close refused: record short");
    }
  }

  const ask = recordCheckDue(progress, ctx.opensInvestigation);
  if (ask !== null) {
    log.info({ turn }, "reads unaccounted for; asking");
    state.sendSystemReminder("record_check", ask);
  }
  // Joined alerts reach the model at the tool boundary, the earliest it can act on one.
  const joined = pendingAlerts(sessionId);
  if (joined.length > 0) {
    state.sendSystemReminder(
      "injected_alerts",
      formatInjectedAlerts(joined.map((j) => j.alert)),
    );
  }
  // The sandbox comes up inside a tool call, so its note is waiting here.
  const sandboxNote = takeSandboxNote(sessionId);
  if (sandboxNote !== null) {
    state.sendSystemReminder("sandbox_ready", sandboxNote);
  }
  state.flush();
  // After the flush, so a crash in between repeats the note rather than losing it.
  markAlertsDelivered(joined.map((j) => j.id));
  return { kind: "continue" };
}
