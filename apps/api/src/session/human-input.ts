import type { NewAuditEvent } from "../audit/audit-store.js";
import {
  deletePendingHumanInput,
  getPendingHumanInputBySessionId,
  resolveGate,
} from "./gate-store.js";
import { findToolCall } from "./transcript-store.js";
import { stripSystemReminder } from "../agent/system-reminder.js";
import type { Dispatcher } from "../dispatcher.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { publishInterruptResolved, publishTranscriptItem } from "./stream.js";
import { toolCallCard, toolCallState } from "./transcript.js";
import { buildSeed } from "./seed.js";
import type {
  ApprovalResponse,
  ApprovalStatus,
  Actor,
  ElicitationAnswerPart,
  RespondRequest,
  ToolApprovalPart,
} from "@nightwarden/shared";

// The three a person can settle a gate with. `pending` and `continued` are the
// other two an approval can be, and neither reaches this turn.
type Settled = Extract<ApprovalStatus, "approved" | "rejected" | "answered">;

export class HumanInputError extends Error {
  constructor(
    public readonly statusCode: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

interface HumanInputActionResult extends ApprovalResponse {
  sessionId: string;
}

function requirePendingHumanInput(sessionId: string) {
  const pending = getPendingHumanInputBySessionId(sessionId);
  if (!pending) {
    throw new HumanInputError(
      409,
      `No pending human input for session: ${sessionId}`,
    );
  }
  return pending;
}

// Both are written in one transaction, so a miss here is a contradiction
// rather than a case to carry forward with an empty tool name.
function requireGatedCall(
  sessionId: string,
  toolCallId: string,
): { name: string; input: Record<string, unknown> } {
  const call = findToolCall(sessionId, toolCallId);
  if (!call) {
    throw new HumanInputError(
      409,
      `No tool call ${toolCallId} in session ${sessionId}`,
    );
  }
  return call;
}

// A write's decision is the audit trail's business; an answer to a question is not.
function approvalAuditEvent(
  sessionId: string,
  part: ToolApprovalPart | ElicitationAnswerPart,
  call: { name: string; input: Record<string, unknown> },
): NewAuditEvent | null {
  if (part.type !== "tool_approval") return null;
  if (part.actor === undefined) {
    throw new Error(`approval of ${call.name} in ${sessionId} has no actor`);
  }
  const target = call.input["target"];
  return {
    actor: part.actor,
    action: part.approved ? "write_approved" : "write_rejected",
    target: typeof target === "string" ? target : null,
    details: {
      tool: call.name,
      input: call.input,
      ...(part.reason !== undefined && { reason: part.reason }),
    },
    sessionId,
  };
}

function ensureDeleted(sessionId: string): void {
  if (!deletePendingHumanInput(sessionId)) {
    throw new HumanInputError(
      409,
      "Human input already resolved by another request",
    );
  }
}

/* Records the decision with the turn it interrupted and claims the run, then
   launches it: the turn carries on from the next call, in the order it was asked. */
function settle(
  dispatcher: Dispatcher,
  sessionId: string,
  gate: { toolCallId: string; askedAt: string },
  status: Settled,
  part: ToolApprovalPart | ElicitationAnswerPart,
  result: ToolResult | null,
  call: { name: string; input: Record<string, unknown> },
): HumanInputActionResult {
  const { toolCallId } = gate;
  const decision = {
    part,
    waitedMs: Date.now() - new Date(gate.askedAt).getTime(),
  };
  const audit = approvalAuditEvent(sessionId, part, call);
  if (!resolveGate(sessionId, toolCallId, decision, result, audit)) {
    throw new HumanInputError(
      409,
      "Human input already resolved by another request",
    );
  }
  const resolvedAt = new Date().toISOString();

  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolCallId,
      toolName: call.name,
      input: call.input,
      state: toolCallState(
        result?.content,
        result?.isError === true,
        null,
        status,
        part.actor ?? null,
      ),
    }),
  });

  publishInterruptResolved({
    sessionId,
    toolCallId,
    status,
    resolvedAt,
  });

  dispatcher.launch({ sessionId, seed: buildSeed(sessionId) });

  return { sessionId, toolCallId, status, resolvedAt };
}

export function respondToPendingHumanInput(
  dispatcher: Dispatcher,
  sessionId: string,
  request: RespondRequest,
  actor: Actor,
): HumanInputActionResult {
  const pending = requirePendingHumanInput(sessionId);
  const { decision, text } = request;

  if (pending.kind === "continue") {
    // No async work between resolve and dispatch, so ensureDeleted alone is the
    // concurrency gate.
    ensureDeleted(sessionId);
    const resolvedAt = new Date().toISOString();
    if (decision === "reject") {
      publishInterruptResolved({
        sessionId,
        toolCallId: pending.toolCallId,
        status: "rejected",
        resolvedAt,
      });
      logger.info({ sessionId }, "continue request ended by user");
      dispatcher.dispatch({
        sessionId,
        seed: buildSeed(sessionId),
        standDown: true,
      });
      return {
        sessionId,
        toolCallId: pending.toolCallId,
        status: "rejected",
        resolvedAt,
      };
    }
    publishInterruptResolved({
      sessionId,
      toolCallId: pending.toolCallId,
      status: "continued",
      resolvedAt,
    });
    logger.info({ sessionId }, "continue request resumed by user");
    dispatcher.dispatch({ sessionId, seed: buildSeed(sessionId) });
    return {
      sessionId,
      toolCallId: pending.toolCallId,
      status: "continued",
      resolvedAt,
    };
  }

  // Everything past the continue branch gates on a real tool call.
  const call = requireGatedCall(sessionId, pending.toolCallId);
  const { toolCallId } = pending;

  // Refused before anything is written, so a malformed request leaves the gate
  // open for the well-formed retry behind it.
  const answer = stripSystemReminder(text?.trim() ?? "");
  if (pending.kind === "clarification") {
    if (decision !== undefined) {
      throw new HumanInputError(
        400,
        "Clarification interrupts do not accept a decision; send text only",
      );
    }
    if (answer === "") {
      throw new HumanInputError(400, "text is required for clarification");
    }
  } else if (decision !== "approve" && decision !== "reject") {
    throw new HumanInputError(
      400,
      "an approval requires a decision of approve or reject",
    );
  }

  if (pending.kind === "clarification") {
    logger.info({ sessionId }, "clarification answered");
    return settle(
      dispatcher,
      sessionId,
      pending,
      "answered",
      { type: "elicitation_answer", toolCallId, actor },
      { toolCallId, content: answer },
      call,
    );
  }

  // kind === "approval"
  if (decision === "approve") {
    // The write runs in the resumed run, which answers it.
    logger.info({ sessionId, tool: call.name }, "approved");
    return settle(
      dispatcher,
      sessionId,
      pending,
      "approved",
      { type: "tool_approval", toolCallId, approved: true, actor },
      null,
      call,
    );
  }

  // Only what is true: the user said no. Inferring a motive from severity
  // would hand the agent one nobody gave, so this asks what to do next.
  const gatedResult: ToolResult = {
    toolCallId,
    content: `The user rejected this call, so it did not run and nothing on the system changed. ${
      answer
        ? `They said: "${answer}". Take that into account`
        : "They gave no reason. Take the rejection itself as the signal"
    }, then continue the investigation with a different approach. Do not call this tool again with the same arguments.`,
    // The tool never ran. That a person chose this is their own fact, which
    // the approval part beside this result carries.
    isError: true,
  };
  logger.info({ sessionId, tool: call.name }, "rejected");
  return settle(
    dispatcher,
    sessionId,
    pending,
    "rejected",
    {
      type: "tool_approval",
      toolCallId,
      approved: false,
      ...(answer !== "" && { reason: answer }),
      actor,
    },
    gatedResult,
    call,
  );
}
