import { METRICS_SOURCE_KINDS, openCandidateIds } from "@nightwarden/shared";
import type { ReportCardItem, ToolName } from "@nightwarden/shared";
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
  recordGaps,
  reportIsBehind,
  setLastStatedCandidates,
  toolCallsIn,
} from "../report.js";
import {
  CANDIDATES_OPENING_MESSAGE,
  CLOSE_PROMPT_MESSAGE,
  closingMessage,
  falsificationMessage,
  frontierMessage,
  REPORT_RETRY_MESSAGE,
  reportRequest,
} from "../prompts/report.js";
import { appendErrorMessage } from "../../session/transcript-store.js";
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
import { citableAnswers } from "./guardrails.js";
import { formatInjectedAlerts } from "./injection.js";
import type { RunContext, RunState, TurnResult } from "./run-state.js";

// What the fleet and the connected integrations currently allow. Read together,
// because the prompt describing them is built from the same call.
export async function currentToolset(
  investigation: boolean,
): Promise<OfferedToolset> {
  const kinds = await connectedKinds();
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
async function suspendOnGate(
  ctx: RunContext,
  gated: Gate,
  toolResults: ToolResult[],
): Promise<void> {
  const { sessionId, log } = ctx;
  const isAskGate = gated.kind === "clarification";
  const interrupt: PendingHumanInput = {
    sessionId,
    toolCallId: gated.tool.toolCallId,
    kind: isAskGate ? "clarification" : "approval",
    completedResults: toolResults,
    claimedAt: null,
  };
  await ctx.state.flush(interrupt);
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

// Keeps the open candidates in view whenever the set changes, so the ones still
// to test are not lost behind a long chain of reads. The set is read live.
async function emitFrontierIfChanged(ctx: RunContext): Promise<void> {
  const record = await getRecord(ctx.sessionId);
  if (record === undefined) return;
  const open = openCandidateIds(record);
  const last = record.lastStatedCandidates;
  const same =
    open.length === last.length &&
    [...open].sort().join("\n") === [...last].sort().join("\n");
  if (same) return;
  await setLastStatedCandidates(ctx.sessionId, open);
  if (open.length > 0) ctx.state.sendSystemReminder(frontierMessage(record));
}

/* The record's own tools, withheld until the phase that needs each. A chat is
   offered none of them, so its phase is always the whole of what it was given. */
const RECORD_TOOL_NAMES: readonly ToolName[] = [
  "OpenCandidates",
  "RecordFinding",
  "CloseInvestigation",
];

type Phase =
  | "gatheringEvidence"
  | "openingCandidates"
  | "testingCandidates"
  | "writingReport"
  | "closingTurn";

/* Every phase is read off what the record and the transcript already hold, so a
   resumed run continues where it reached rather than repeating a phase. */
async function phaseOf(ctx: RunContext, state: RunState): Promise<Phase> {
  if (!ctx.opensInvestigation) return "testingCandidates";
  if (!state.evidenceGathered) return "gatheringEvidence";
  const record = await getRecord(ctx.sessionId);
  if (record === undefined || record.candidates.length === 0)
    return "openingCandidates";
  const behind = reportIsBehind(record, ctx.approvedWrites);
  /* Challenged and settled, write-up behind the record: a refused ComposeReport
     leaves both true (the retry), and a later run that settles more revises here. */
  if (behind && state.reportUnlocked) {
    if (openCandidateIds(record).length === 0) return "writingReport";
  }
  // The write-up is current, so the one thing left is to say so to the reader.
  if (!behind && !state.closingTurnDone) return "closingTurn";
  return "testingCandidates";
}

/* One set both shown to the model and executed from, so a turn cannot be offered
   what it cannot run; a tool the run must not reach for yet is not on the turn. */
function toolsForPhase(phase: Phase, offered: OfferedToolset): OfferedToolset {
  const keep = (names: (name: ToolName) => boolean): OfferedToolset => ({
    tools: offered.tools.filter((tool) => names(tool.schema.name)),
    elicitations: offered.elicitations,
  });
  switch (phase) {
    case "gatheringEvidence":
      return keep((name) => !RECORD_TOOL_NAMES.includes(name));
    case "openingCandidates":
      return keep((name) => name === "OpenCandidates");
    case "testingCandidates":
      return offered;
    /* The write-up is composed from the record, and asking a human is already
       settled by the time it runs, so neither is on the turn. */
    case "writingReport":
      return { tools: [COMPOSE_REPORT_TOOL], elicitations: [] };
    case "closingTurn":
      return { tools: [], elicitations: [] };
  }
}

/* An accepted close means the record is whole: the challenge runs first where
   there is anything to break, otherwise phaseOf reads the write-up off the record. */
async function offerFalsification(ctx: RunContext): Promise<void> {
  const { state, sessionId } = ctx;
  const record = await getRecord(sessionId);
  if (
    !state.challengeIssued &&
    record !== undefined &&
    record.candidates.length > 0
  ) {
    state.challengeIssued = true;
    state.sendSystemReminder(falsificationMessage(record));
    return;
  }
  // A close once the challenge is out means the run has nothing further to break,
  // so the report is reached; a close only ever lands a turn later than it.
  if (state.challengeIssued) state.reportUnlocked = true;
}

/* The tool already named what is missing, so this only spends the allowance.
   Null lets the run carry on and settle what it owes. */
async function spendCloseRefusal(
  ctx: RunContext,
  turn: number,
): Promise<TurnResult | null> {
  const pushback = ctx.finishGate(await recordGaps(ctx.sessionId));
  if (pushback !== null) {
    ctx.log.info(
      { turn, gap: pushback.kind, count: pushback.count },
      "close refused: the record is still short",
    );
    return null;
  }
  ctx.log.warn(
    { turn },
    "close refused past its allowance; standing down without a report",
  );
  return { kind: "stand_down" };
}

// One id, because a session has one report: a later phase replaces the card
// rather than stacking a second one under the first.
export function publishReportCard(
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
async function writeUpRequest(ctx: RunContext): Promise<string> {
  const record = await getRecord(ctx.sessionId);
  const gated = gatedCalls(await toolCallsIn(ctx.sessionId));
  /* Only a run that acted must recommend: ruling things out is a complete
     ending, but releasing a write and going quiet leaves the user nothing. */
  const unrecovered =
    approvedWriteCount(gated) > 0 &&
    (await recoveryState(ctx.sessionId)) === "unconfirmed";
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
  const nowOffered = await currentToolset(ctx.opensInvestigation);
  const change = toolsetChange(state.offered, nowOffered);
  if (change !== null) {
    log.info({ turn, change }, "offered toolset changed mid-run");
    state.offered = nowOffered;
    state.sendSystemReminder(change);
    await state.flush();
  }

  // Which phase the run is in, read from what the record holds rather than
  // remembered, so a resumed run lands where it left off.
  const phase = await phaseOf(ctx, state);
  /* Each phase says what it wants before it offers the tools to answer with, so
     the ask and the toolset that serves it are decided in one place. */
  if (phase === "openingCandidates") {
    state.sendSystemReminder(CANDIDATES_OPENING_MESSAGE);
  } else if (phase === "writingReport") {
    const attempt = ctx.reportAttempts();
    if (attempt === null) {
      log.warn({ turn }, "write-up not written within its attempts");
      await appendErrorMessage(sessionId, REPORT_GIVEN_UP);
      publishReportCard(sessionId, "failed");
      return { kind: "outcome", outcome: "completed" };
    }
    publishReportCard(sessionId, "building");
    state.sendSystemReminder(
      attempt === 1 ? await writeUpRequest(ctx) : REPORT_RETRY_MESSAGE,
    );
  } else if (phase === "closingTurn") {
    const record = await getRecord(sessionId);
    if (record === undefined) return { kind: "outcome", outcome: "completed" };
    state.closingTurnDone = true;
    state.sendSystemReminder(closingMessage(record));
  }
  await state.flush();
  const forThisPhase = toolsForPhase(phase, state.offered);
  const toolSchemas = offeredSchemas(forThisPhase);

  const startedAt = Date.now();
  let response: ChatResponse;
  try {
    response = await ctx.chat(
      state.conversation(),
      toolSchemas,
      state.nextSeq,
      ctx.runSignal,
    );
    state.stage("assistant", response.parts);
  } catch (err) {
    if (ctx.signal?.aborted) {
      log.info({ turn }, "run stopped by user");
      await state.flush();
      return { kind: "outcome", outcome: "stopped" };
    }
    // The budget cut the turn short. That is the check-in, not a failure, so it
    // leaves the loop rather than killing the run.
    if (ctx.outOfTime.aborted) {
      log.info({ turn }, "time budget reached mid-turn");
      await state.flush();
      return { kind: "budget" };
    }
    throw err;
  }
  if (ctx.signal?.aborted) {
    log.info({ turn }, "run stopped by user");
    await state.flush();
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
  await state.flush();

  // A lost write-up says so in its own terms; the ending is written to the
  // transcript, since without an error row a nothing turn derives to completed.
  const reportLost =
    phase === "writingReport"
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
    await appendErrorMessage(sessionId, ending);
    return { kind: "outcome", outcome: "completed" };
  }

  /* The last phase: the reader has been addressed and there is nothing after it,
     so the run ends here however the model spent the turn. */
  if (phase === "closingTurn") {
    log.info({ turn }, "investigation written up and closed");
    return { kind: "outcome", outcome: "completed" };
  }

  if (response.toolUses.length === 0) {
    if (!ctx.opensInvestigation) {
      log.info({ turn }, "chat finished with free-form response");
      return { kind: "outcome", outcome: "completed" };
    }
    /* Finishing is an act here, so a turn that asked for nothing has not asked to
       finish. Say so, and stand down once the allowance for saying it is spent. */
    if (ctx.closePrompts()) {
      log.info(
        { turn },
        "investigation turn called no tool; asking it to close",
      );
      state.sendSystemReminder(CLOSE_PROMPT_MESSAGE);
      await state.flush();
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
  };

  const { toolResults, gated, refused } = await processToolUses({
    toolUses: response.toolUses,
    offered: forThisPhase,
    sessionId,
    execCtx,
    log,
    alreadyRefused: state.refusedNames,
  });
  for (const name of refused) {
    state.refusedNames.set(name, (state.refusedNames.get(name) ?? 0) + 1);
  }

  const barren = ctx.barrenTurns(
    response.toolUses.length,
    refused.length,
    state.offered,
  );
  if (barren !== null) {
    log.warn(
      { turn, refused: [...state.refusedNames.keys()] },
      "run asked only for unavailable tools; ending it",
    );
    state.stageResults(response.toolUses, toolResults);
    await state.flush();
    await appendErrorMessage(sessionId, barren);
    return { kind: "outcome", outcome: "completed" };
  }

  // A turn's tools outlive the stop that arrives during them, so the gate is
  // reached already aborted; suspending here parks an interrupt on a dead run.
  if (ctx.signal?.aborted) {
    log.info({ turn }, "run stopped by user before the gate");
    await state.flush();
    return { kind: "outcome", outcome: "stopped" };
  }

  if (gated !== null) {
    // Suspended sessions take no injections, so the inbox is not drained here.
    await suspendOnGate(ctx, gated, toolResults);
    return { kind: "outcome", outcome: "suspended" };
  }

  // Drained at the tool boundary, the earliest point the model can act on one,
  // as their own turn after the results.
  state.stageResults(response.toolUses, toolResults);
  // Already durable: the dispatcher wrote each one when it arrived. The inbox
  // exists to tell the model, which is a separate concern from keeping it.
  const injected = ctx.drainInbox?.(sessionId) ?? [];
  if (injected.length > 0) {
    state.sendSystemReminder(formatInjectedAlerts(injected));
  }

  await emitFrontierIfChanged(ctx);

  /* The write-up landed, so the card that was spinning now names what it opens.
     A refusal leaves the record behind, which is the next turn's write-up phase. */
  if (phase === "writingReport") {
    const wrote = response.toolUses.some(
      (use) =>
        use.name === "ComposeReport" &&
        toolResults.some(
          (result) =>
            result.toolCallId === use.toolCallId && result.isError !== true,
        ),
    );
    if (wrote) {
      publishReportCard(
        sessionId,
        "ready",
        (await getRecord(sessionId))?.report?.headline,
      );
    }
  }

  const closing = response.toolUses.find(
    (use) => use.name === "CloseInvestigation",
  );
  if (closing !== undefined) {
    const accepted = toolResults.some(
      (result) =>
        result.toolCallId === closing.toolCallId && result.isError !== true,
    );
    if (accepted) await offerFalsification(ctx);
    else {
      const ending = await spendCloseRefusal(ctx, turn);
      if (ending !== null) {
        await state.flush();
        return ending;
      }
    }
  }

  const claims = ((await getRecord(sessionId))?.findings ?? []).length;
  const ask = ctx.recordDebt.check(
    claims,
    citableAnswers(response.toolUses, toolResults),
  );
  if (ask !== null) {
    log.info({ turn }, "reads unaccounted for; asking");
    state.sendSystemReminder(ask);
  }
  await state.flush();
  return { kind: "continue" };
}
