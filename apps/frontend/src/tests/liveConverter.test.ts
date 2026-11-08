import { describe, it, expect } from "vitest";
import type { FrontendEvent } from "@nightwarden/shared";

import {
  applyLiveEvent,
  hasActiveStream,
} from "@/features/session/transcript/liveConverter";
import type { TranscriptItem } from "@/features/session/transcript/types";

function textDelta(delta: string, turn = 1, block = 0): FrontendEvent {
  return {
    messageId: "m1",
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId: "s1", delta, turn, block },
  };
}

function retrying(sessionId = "s1"): FrontendEvent {
  return {
    messageId: "m1",
    type: "RUN_RETRYING",
    payload: {
      sessionId,
      summary: "Provider error (502). Retrying…",
    },
  };
}

// The API builds the card; these mirror what it sends.
function itemEvent(item: TranscriptItem): FrontendEvent {
  return {
    messageId: "m1",
    type: "TRANSCRIPT_ITEM",
    payload: { sessionId: "s1", item },
  };
}

function toolCallStart(toolCallId: string): FrontendEvent {
  return itemEvent({
    kind: "tool_call",
    toolCallId,
    toolName: "check_service_status",
    input: {},
    state: { phase: "running" },
  });
}

function toolCallEnd(toolCallId: string, result: unknown): FrontendEvent {
  return itemEvent({
    kind: "tool_call",
    toolCallId,
    toolName: "check_service_status",
    input: {},
    state: { phase: "complete", result },
  });
}

function continueInterrupt(toolCallId: string): FrontendEvent {
  return itemEvent({
    kind: "continue_card",
    toolCallId,
    state: { phase: "awaiting_human" },
  });
}

function interruptResolved(
  toolCallId: string,
  status: "approved" | "rejected" | "answered" | "continued",
): FrontendEvent {
  return itemEvent({
    kind: "continue_card",
    toolCallId,
    state: { phase: "resolved", decision: status },
  });
}

describe("applyLiveEvent — continue interrupt", () => {
  it("inserts the continue card the API sent", () => {
    const items = applyLiveEvent([], continueInterrupt("ci-1"), "s1");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "continue_card",
      toolCallId: "ci-1",
    });
  });

  it("resolves the card with the decision", () => {
    let items = applyLiveEvent([], continueInterrupt("ci-1"), "s1");
    items = applyLiveEvent(items, interruptResolved("ci-1", "continued"), "s1");

    expect(items[0]).toMatchObject({
      kind: "continue_card",
      state: { phase: "resolved", decision: "continued" },
    });
  });

  it("carries a rejection through as the decision, not a generic pending state", () => {
    let items = applyLiveEvent([], continueInterrupt("ci-1"), "s1");
    items = applyLiveEvent(items, interruptResolved("ci-1", "rejected"), "s1");

    expect(items[0]).toMatchObject({
      kind: "continue_card",
      state: { phase: "resolved", decision: "rejected" },
    });
  });
});

describe("applyLiveEvent — block identity", () => {
  // The projection ids a saved part `assistant-${seq}-${block}`, and the stream
  // carries the same turn and block, so the two key alike and never remount.
  it("keys a streamed row with the id the server will save it under", () => {
    const items = applyLiveEvent([], textDelta("An answer", 7, 2), "s1");
    expect(items[0]).toMatchObject({ id: "assistant-7-2" });
  });

  it("splits two text blocks that arrive back to back into distinct rows", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, textDelta("First", 1, 0), "s1");
    items = applyLiveEvent(items, textDelta("Second", 1, 1), "s1");

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "assistant-1-0", text: "First" });
    expect(items[1]).toMatchObject({ id: "assistant-1-1", text: "Second" });
  });
});

describe("applyLiveEvent — a retry restarts the turn's stream", () => {
  it("drops the partial text so the re-stream replaces it", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(
      items,
      textDelta("The api container was OOM", 1, 1),
      "s1",
    );
    items = applyLiveEvent(items, retrying(), "s1");
    expect(items).toHaveLength(0);

    items = applyLiveEvent(items, textDelta("The api pod restarted."), "s1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "agent_text",
      text: "The api pod restarted.",
    });
  });

  it("leaves a finished tool card in place, dropping only the trailing stream", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, toolCallStart("tu-1"), "s1");
    items = applyLiveEvent(items, toolCallEnd("tu-1", "ok"), "s1");
    items = applyLiveEvent(items, textDelta("Reading the result"), "s1");
    items = applyLiveEvent(items, retrying(), "s1");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "tu-1" });
  });

  it("ignores a retry for a different session", () => {
    let items = applyLiveEvent([], textDelta("keep me"), "s1");
    items = applyLiveEvent(items, retrying("other-session"), "s1");
    expect(items).toHaveLength(1);
  });
});

describe("hasActiveStream", () => {
  /* Whether the live line shows. Every branch, and both sides of the one
     boolean, which is a table rather than a case apiece. */
  it.each([
    ["nothing has arrived", [], false],
    ["an answer is streaming", [textDelta("Here is")], true],
    ["a tool call is in flight", [toolCallStart("tu-1")], true],
    [
      "that tool call has answered",
      [toolCallStart("tu-1"), toolCallEnd("tu-1", "ok")],
      false,
    ],
  ])("is %s -> %s", (_label, events, expected) => {
    const items = (events as FrontendEvent[]).reduce<TranscriptItem[]>(
      (acc, event) => applyLiveEvent(acc, event, "s1"),
      [],
    );
    expect(hasActiveStream(items)).toBe(expected);
  });
});
