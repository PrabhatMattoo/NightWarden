import { describe, it, expect } from "vitest";

import { segmentRuns } from "@/features/session/transcript/segmentRuns";
import type { RunNode } from "@/features/session/transcript/segmentRuns";
import type {
  TranscriptItem,
  ToolCallItem,
} from "@/features/session/transcript/types";

const user = (seq: number, at?: string): TranscriptItem => ({
  kind: "user_turn",
  id: `user-${seq}`,
  text: `q${seq}`,
  ...(at !== undefined && { timestamp: at }),
});

const prose = (seq: number, at?: string): TranscriptItem => ({
  kind: "agent_text",
  id: `assistant-${seq}-0`,
  text: `note ${seq}`,
  turn: seq,
  ...(at !== undefined && { timestamp: at }),
});

const tool = (seq: number, at?: string): ToolCallItem => ({
  kind: "tool_call",
  toolCallId: `tu-${seq}`,
  toolName: "GetDockerLogs",
  input: {},
  state: { phase: "complete", result: "ok" },
  ...(at !== undefined && { timestamp: at }),
});

const gated = (seq: number, at?: string): ToolCallItem => ({
  kind: "tool_call",
  toolCallId: `tu-gate-${seq}`,
  toolName: "AskUserQuestion",
  input: {},
  state: { phase: "awaiting_human", gate: "clarification" },
  ...(at !== undefined && { timestamp: at }),
});

const failure = (seq: number, at?: string): TranscriptItem => ({
  kind: "error_text",
  id: `error-${seq}`,
  text: "The model provider had a server problem.",
  ...(at !== undefined && { timestamp: at }),
});

const answer = (seq: number, at?: string): TranscriptItem => ({
  kind: "agent_text",
  id: `assistant-${seq}-1`,
  text: `answer ${seq}`,
  turn: seq,
  ...(at !== undefined && { timestamp: at }),
});

const openingAlert: TranscriptItem = {
  kind: "alert_arrived",
  id: "alert-1",
  alertName: "HighMemory",
  severityLabel: "critical",
  opening: true,
};

function groups(nodes: RunNode[]): Extract<RunNode, { kind: "group" }>[] {
  return nodes.flatMap((n) => (n.kind === "group" ? [n] : []));
}

describe("segmentRuns", () => {
  /* One run, one group, whatever the run turned out to contain: the shape is
     settled when the run opens, so nothing re-parents once a tool arrives. */
  it("gives a trivial turn a group holding nothing, with the answer outside", () => {
    const nodes = segmentRuns([user(0), answer(1)], false);
    const [g] = groups(nodes);
    expect(g!.items).toEqual([]);
    expect(g!.answer?.kind).toBe("agent_text");
  });

  /* A provider failing is part of the run it failed in. Splitting there started
     a second group whose clock ran from the error, not from the message. */
  it("keeps a failed run whole, with the failure standing outside the group", () => {
    const nodes = segmentRuns(
      [
        user(0, "2024-01-01T00:00:00Z"),
        tool(1),
        failure(1, "2024-01-01T00:01:00Z"),
      ],
      false,
    );
    expect(groups(nodes)).toHaveLength(1);
    const [g] = groups(nodes);
    expect(g!.startedAt).toBe("2024-01-01T00:00:00Z");
    expect(g!.answer?.kind).toBe("error_text");
    expect(g!.items.map((i) => i.kind)).toEqual(["tool_call"]);
  });

  /* The answer is outside the group from its first token, so a run ending does
     not lift the reply the reader is already halfway through. */
  it("stands a still-streaming answer outside its live group", () => {
    const live = segmentRuns([user(0), tool(1), answer(1)], true);
    const [g] = groups(live);
    expect(g!.live).toBe(true);
    expect(g!.answer?.id).toBe("assistant-1-1");
    expect(g!.items.map((i) => i.kind)).toEqual(["tool_call"]);

    // And it is in the same place once the run settles: nothing moved.
    const settled = segmentRuns([user(0), tool(1), answer(1)], false);
    const [s] = groups(settled);
    expect(s!.answer?.id).toBe("assistant-1-1");
    expect(s!.items.map((i) => i.kind)).toEqual(["tool_call"]);
  });

  /* Waiting on a person is part of the run, so the group holds the call and
     stays live: the header keeps counting instead of settling and reopening. */
  it("keeps a call waiting on a human inside its run, still live", () => {
    const nodes = segmentRuns([user(0), prose(1), gated(1)], true);
    expect(groups(nodes)).toHaveLength(1);
    const [g] = groups(nodes);
    expect(g!.live).toBe(true);
    expect(g!.answer).toBeNull();
    expect(g!.items.map((i) => i.kind)).toEqual(["agent_text", "tool_call"]);
  });

  it("folds a run's prose and tools into one group and stands the answer outside it", () => {
    const nodes = segmentRuns([user(0), prose(1), tool(1), answer(1)], false);
    const [g] = groups(nodes);
    expect(g).toBeDefined();
    expect(g!.items.map((i) => i.kind)).toEqual(["agent_text", "tool_call"]);
    // The answer rides on the group node so the group draws it below itself,
    // outside the collapsible activity.
    expect(g!.answer?.kind).toBe("agent_text");
    expect(g!.live).toBe(false);
    expect(
      nodes.map((n) => (n.kind === "item" ? n.item.kind : "group")),
    ).toEqual(["user_turn", "group"]);
  });

  it("nests intermediary prose and keeps only the last answer outside", () => {
    const nodes = segmentRuns(
      [user(0), tool(1), answer(1), tool(2), answer(2)],
      false,
    );
    const [g] = groups(nodes);
    expect(g!.items.map((i) => i.kind)).toEqual([
      "tool_call",
      "agent_text",
      "tool_call",
    ]);
    expect(g!.answer?.id).toBe("assistant-2-1");
  });

  it("holds a live run open with no answer split out", () => {
    const nodes = segmentRuns([user(0), prose(1), tool(1)], true);
    const [g] = groups(nodes);
    expect(g!.live).toBe(true);
    expect(g!.answer).toBeNull();
    expect(g!.items.map((i) => i.kind)).toEqual(["agent_text", "tool_call"]);
  });

  it("settles earlier runs while only the last stays live", () => {
    const nodes = segmentRuns(
      [user(0), tool(1), answer(1), user(2), tool(3)],
      true,
    );
    const gs = groups(nodes);
    expect(gs).toHaveLength(2);
    expect(gs[0]!.live).toBe(false);
    expect(gs[0]!.answer?.id).toBe("assistant-1-1");
    expect(gs[1]!.live).toBe(true);
    expect(gs[1]!.answer).toBeNull();
  });

  it("opens a run on the alert an investigation started from", () => {
    const nodes = segmentRuns([openingAlert, tool(1), answer(1)], false);
    expect(nodes[0]).toMatchObject({ kind: "item", item: { opening: true } });
    expect(groups(nodes)).toHaveLength(1);
  });

  it("reads the run's span off the first and last timestamps it carries", () => {
    const nodes = segmentRuns(
      [
        user(0, "2026-06-13T00:00:00.000Z"),
        tool(1, "2026-06-13T00:00:10.000Z"),
        answer(1, "2026-06-13T00:02:00.000Z"),
      ],
      false,
    );
    const [g] = groups(nodes);
    expect(g!.startedAt).toBe("2026-06-13T00:00:00.000Z");
    expect(g!.endedAt).toBe("2026-06-13T00:02:00.000Z");
  });

  it("splits a run that an alert interrupts into a group on either side", () => {
    const interrupt: TranscriptItem = {
      kind: "alert_arrived",
      id: "alert-2",
      alertName: "DiskFull",
      severityLabel: null,
    };
    const nodes = segmentRuns(
      [user(0), tool(1), interrupt, tool(2), answer(2)],
      false,
    );
    expect(
      nodes.map((n) => (n.kind === "item" ? n.item.kind : "group")),
    ).toEqual(["user_turn", "group", "alert_arrived", "group"]);
  });
});
