import type {
  ApprovalStatus,
  CandidateRow,
  ContinueCardItem,
  Actor,
  ElicitationAnswerPart,
  InvestigationRecord,
  TranscriptRow,
  ToolApprovalPart,
  ToolCallState,
  ToolGate,
  TranscriptItem,
} from "@nightwarden/shared";
import { openCandidateIds, standingFindings } from "@nightwarden/shared";
import {
  getOpenTurn,
  getPendingHumanInputBySessionId,
  hasPendingHumanInput,
} from "./gate-store.js";
import { getRecord } from "./record-store.js";
import { isRunning } from "./status-store.js";
import { getSession } from "./store.js";
import { getTranscriptRows } from "./transcript-store.js";

// The tool input's target key. A write addresses a service by it, and a tool
// that names none is not addressing one.
export function targetKeyFromInput(
  input: Record<string, unknown>,
): string | null {
  const target = input["target"];
  return typeof target === "string" ? target : null;
}

// Called by both the transcript fetch and the live stream, so the two cannot
// differ. It chooses nothing: the call's state says where in its life it is.
export function toolCallCard(call: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  state: ToolCallState;
  // How many times this same write already ran in this investigation. The
  // caller counts it, because only a walk of the transcript can.
  priorRuns?: number;
  // Present on a projected call, absent while it streams live.
  timestamp?: string;
}): TranscriptItem {
  const { toolCallId, toolName, input, state, timestamp } = call;
  const priorRuns = call.priorRuns ?? 0;
  return {
    kind: "tool_call",
    toolCallId,
    toolName,
    input,
    ...(priorRuns > 0 && { priorRuns }),
    state,
    ...(timestamp !== undefined && { timestamp }),
  };
}

// The time-budget prompt, which no model asked for and which answers to nobody's
// tool call. Its own function because its states are its own.
export function continueCard(
  toolCallId: string,
  state: ContinueCardItem["state"],
): ContinueCardItem {
  return { kind: "continue_card", toolCallId, state };
}

// Repeating a fix is rarely fixing it, and 3am is when that is easiest to
// miss. It reports and never refuses: a fifth restart is a decision.
function priorRunsOf(
  toolName: string,
  input: Record<string, unknown>,
  approved: Array<{ toolName: string; target: string | null }>,
): number {
  const target = targetKeyFromInput(input);
  if (target === null) return 0;
  return approved.filter((a) => a.toolName === toolName && a.target === target)
    .length;
}

// Read from the report column, since the write-up is not a turn. A session
// parked on a human has not reached that turn, so it gets no card.
function reportCard(sessionId: string): TranscriptItem | null {
  const session = getSession(sessionId);
  if (session === undefined || !session.investigation) return null;
  const report = getRecord(sessionId)?.report ?? null;
  if (report != null) {
    // A run in flight writes this again over the same column, so without the
    // building state a follow-up reads as finished the moment it starts.
    const phase = isRunning(sessionId) ? "building" : "ready";
    return {
      kind: "report_card",
      id: "report",
      state: { phase },
      headline: report.headline,
    };
  }
  if (isRunning(sessionId) || hasPendingHumanInput(sessionId)) return null;
  /* Owed only once the record is complete, which is also what unlocks the report
     turn. Between two runs of one investigation a candidate is still open. */
  const record = getRecord(sessionId);
  if (record === undefined || record.findings.length === 0) return null;
  if (openCandidateIds(record).length > 0) return null;
  return { kind: "report_card", id: "report", state: { phase: "failed" } };
}

// A tool call's state, in precedence order: what the session is suspended on
// beats what a human already decided, which beats the tool merely having run.
export function toolCallState(
  result: string | undefined,
  failed: boolean,
  gate: ToolGate | null,
  decided: ApprovalStatus | null,
  actor: Actor | null,
): ToolCallState {
  if (gate !== null) return { phase: "awaiting_human", gate };
  // The decision was recorded when they were asked, so nothing has to work out
  // from a tool's name whether the words in a result are theirs.
  if (decided !== null)
    return {
      phase: "resolved",
      decision: decided,
      ...(result !== undefined && { result }),
      ...(actor !== null && { actor }),
    };
  if (result === undefined) return { phase: "running" };
  return { phase: "complete", result, ...(failed && { isError: true }) };
}

// A candidate's state read live off the record: the verdict of the finding that
// stands for it, or open until one does.
function candidateRows(record: InvestigationRecord): CandidateRow[] {
  const standing = new Map(
    standingFindings(record.findings).map((f) => [f.candidate, f]),
  );
  return record.candidates.map((c) => {
    const settling = standing.get(c.id);
    if (settling === undefined) {
      return { id: c.id, statement: c.statement, state: "open" };
    }
    return {
      id: c.id,
      statement: c.statement,
      state: settling.verdict,
      ...(settling.explanation.trim() !== "" && {
        note: firstSentence(settling.explanation),
      }),
    };
  });
}

/* The board is a glance at what is settled, not the reasoning behind it: the
   whole explanation belongs under the finding, which the verdict links to. */
function firstSentence(explanation: string): string {
  const trimmed = explanation.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  const first = end === -1 ? trimmed : trimmed.slice(0, end + 1);
  return first.length <= MAX_BOARD_NOTE_CHARS
    ? first
    : `${first.slice(0, MAX_BOARD_NOTE_CHARS).trimEnd()}…`;
}

// One line on a docked strip, which is what the board is read from.
const MAX_BOARD_NOTE_CHARS = 140;

// Everything the frontend needs about a call is decided here, so the browser
// never reconciles two sources against each other.
export function buildTranscript(sessionId: string): TranscriptItem[] {
  const messages: TranscriptRow[] = getTranscriptRows(sessionId);
  // The board is docked rather than drawn in the stream, so one item carries the
  // live state wherever the reader is scrolled.
  const record = getRecord(sessionId);
  let candidateCardDrawn = false;
  // Which call is waiting, and of what kind. What that call was comes from the
  // transcript rows below, which hold it already.
  const pending = getPendingHumanInputBySessionId(sessionId) ?? null;

  // One pass: what a call returned, whether it failed, and what a person said
  // about it, each read from the part that records it.
  const results = new Map<string, string>();
  const failed = new Set<string>();
  const decisions = new Map<string, ApprovalStatus>();
  const deciders = new Map<string, Actor>();
  const recordDecision = (
    part: ToolApprovalPart | ElicitationAnswerPart,
  ): void => {
    if (part.type === "elicitation_answer") {
      decisions.set(part.toolCallId, "answered");
    } else {
      decisions.set(part.toolCallId, part.approved ? "approved" : "rejected");
    }
    if (part.actor) deciders.set(part.toolCallId, part.actor);
  };
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool_result") {
        results.set(part.toolCallId, part.output);
        if (part.isError === true) failed.add(part.toolCallId);
      } else if (
        part.type === "tool_approval" ||
        part.type === "elicitation_answer"
      ) {
        recordDecision(part);
      }
    }
  }
  /* A gate interrupts a turn before its answers have a row, so the answers given
     so far are read from the open turn that holds them. */
  const openTurn = getOpenTurn(sessionId);
  for (const result of openTurn?.results ?? []) {
    results.set(result.toolCallId, result.content);
    if (result.isError === true) failed.add(result.toolCallId);
  }
  for (const { part } of openTurn?.decisions ?? []) recordDecision(part);

  const alerts = getSession(sessionId)?.alerts ?? [];
  // Separated by the row rather than by compared clocks: whether an alert opened
  // the session or interrupted it is known at the moment it is written.
  const arrivals = alerts.filter((entry) => entry.injected);
  let nextArrival = 0;

  // Writes the user already released, in the order they ran, so the approval
  // card can say this is the third restart of the same service.
  const approved: Array<{ toolName: string; target: string | null }> = [];

  const items: TranscriptItem[] = [];
  // First, because it is what the session began from: an investigation that
  // opens on the agent working reads as one it started of its own accord.
  for (const entry of alerts.filter((a) => !a.injected)) {
    items.push({
      kind: "alert_arrived",
      id: `alert-${entry.alert.sourceAlertId}-${entry.arrivedAt}`,
      alertName: entry.alert.alertName,
      severityLabel: entry.alert.labels["severity"] ?? null,
      opening: true,
    });
  }

  for (const msg of messages) {
    // Placed where it interrupted: everything the agent did before this message
    // happened before the alert landed, and everything after it, after.
    while (
      nextArrival < arrivals.length &&
      arrivals[nextArrival]!.arrivedAt <= msg.timestamp
    ) {
      const entry = arrivals[nextArrival]!;
      items.push({
        kind: "alert_arrived",
        id: `alert-${entry.alert.sourceAlertId}-${entry.arrivedAt}`,
        alertName: entry.alert.alertName,
        severityLabel: entry.alert.labels["severity"] ?? null,
      });
      nextArrival++;
    }

    // The harness talking to the model, not the user. Stored so a resume replays
    // faithfully, and never drawn, so the transcript reads as one conversation.
    if (msg.kind === "system_reminder") continue;

    if (msg.kind === "error") {
      if (msg.content) {
        items.push({
          kind: "error_text",
          id: `error-${msg.seq}`,
          text: msg.content,
        });
      }
      continue;
    }

    if (msg.parts.length === 0) {
      if (msg.content) {
        items.push(
          msg.kind === "user"
            ? {
                kind: "user_turn",
                id: `user-${msg.seq}`,
                text: msg.content,
                timestamp: msg.timestamp,
              }
            : {
                kind: "agent_text",
                id: `${msg.kind}-${msg.seq}`,
                text: msg.content,
                turn: msg.seq,
                timestamp: msg.timestamp,
              },
        );
      }
      continue;
    }

    let idx = 0;
    let behindGate = false;
    for (const part of msg.parts) {
      // A streamed block carries its own ordinal, so its id matches the row the
      // client already drew; an older part falls back to its position.
      const ordinal =
        (part.type === "text" ||
          part.type === "reasoning" ||
          part.type === "compaction") &&
        part.block !== undefined
          ? part.block
          : idx;
      idx++;
      const id = `${msg.kind}-${msg.seq}-${ordinal}`;
      if (part.type === "text") {
        if (!part.text) continue;
        items.push(
          msg.kind === "user"
            ? {
                kind: "user_turn",
                // The sender's own id, so the bubble it drew is this one.
                id: msg.clientId ?? id,
                text: part.text,
                timestamp: msg.timestamp,
              }
            : {
                kind: "agent_text",
                id,
                text: part.text,
                turn: msg.seq,
                timestamp: msg.timestamp,
              },
        );
      } else if (part.type === "compaction") {
        items.push({ kind: "compaction", id });
      } else if (part.type === "tool_call") {
        /* The board is docked and drawn once here; the call keeps its own row,
           because committing to what to test is itself the work worth showing. */
        if (
          part.name === "OpenCandidates" &&
          !candidateCardDrawn &&
          record !== undefined &&
          record.candidates.length > 0
        ) {
          items.push({
            kind: "candidate_card",
            id: "candidates",
            rows: candidateRows(record),
          });
          candidateCardDrawn = true;
        }
        const awaiting =
          pending?.toolCallId === part.toolCallId ? pending : null;
        // "continue" cannot reach here: its id is synthetic and answers to no
        // turn, so it never matches a tool call part.
        const gate =
          awaiting !== null && awaiting.kind !== "continue"
            ? awaiting.kind
            : null;
        const decided =
          awaiting === null ? (decisions.get(part.toolCallId) ?? null) : null;
        const decider =
          awaiting === null ? (deciders.get(part.toolCallId) ?? null) : null;
        // Asked for behind the call a person is deciding, so it has not started.
        const queued = behindGate && !results.has(part.toolCallId);
        items.push(
          toolCallCard({
            toolCallId: part.toolCallId,
            toolName: part.name,
            input: part.input,
            state: queued
              ? { phase: "queued" }
              : toolCallState(
                  results.get(part.toolCallId),
                  failed.has(part.toolCallId),
                  gate,
                  decided,
                  decider,
                ),
            priorRuns: priorRunsOf(part.name, part.input, approved),
            timestamp: msg.timestamp,
          }),
        );
        if (awaiting !== null) behindGate = true;
        // Counted in transcript order, so a card reports what ran before it and
        // never counts itself.
        if (decided === "approved") {
          approved.push({
            toolName: part.name,
            target: targetKeyFromInput(part.input),
          });
        }
      }
    }
  }

  // An alert that landed after the last persisted turn still belongs on the end
  // rather than nowhere.
  for (const entry of arrivals.slice(nextArrival)) {
    items.push({
      kind: "alert_arrived",
      id: `alert-${entry.alert.sourceAlertId}-${entry.arrivedAt}`,
      alertName: entry.alert.alertName,
      severityLabel: entry.alert.labels["severity"] ?? null,
    });
  }

  // No model asked for it, so the walk above has no tool call to project. The
  // interrupt row is the only record, or a reloaded session offers no way out.
  if (pending?.kind === "continue") {
    items.push(continueCard(pending.toolCallId, { phase: "awaiting_human" }));
  }

  // Last, because writing up is the last thing a run does.
  const report = reportCard(sessionId);
  if (report !== null) items.push(report);

  return items;
}
