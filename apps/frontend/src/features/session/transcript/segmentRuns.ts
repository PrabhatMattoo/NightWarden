// A run is the stretch from a person's message (or an opening alert) to the
// agent's terminal answer; its tools and notes collapse into one group.

import { transcriptItemKey } from "@nightwarden/shared";
import type { TranscriptItem, AgentTextItem, ErrorTextItem } from "./types.js";

export type RunNode =
  | { kind: "item"; item: TranscriptItem }
  | {
      kind: "group";
      id: string;
      // Tool calls and any prose before the answer, in order.
      items: TranscriptItem[];
      // How the run ended, rendered outside the group: its answer, or the
      // failure that stopped it. Null while neither has arrived.
      answer: AgentTextItem | ErrorTextItem | null;
      // Still running: the group stays open and reads "Working for Xs".
      live: boolean;
      startedAt?: string;
      endedAt?: string;
    };

function opensRun(item: TranscriptItem): boolean {
  if (item.kind === "user_turn") return true;
  return item.kind === "alert_arrived" && item.opening === true;
}

function nests(item: TranscriptItem): boolean {
  return (
    item.kind === "tool_call" ||
    item.kind === "agent_text" ||
    item.kind === "error_text" ||
    item.kind === "compaction"
  );
}

function timestampOf(
  item: TranscriptItem | null | undefined,
): string | undefined {
  return item != null && "timestamp" in item ? item.timestamp : undefined;
}

function firstTimestamp(items: TranscriptItem[]): string | undefined {
  for (const item of items) {
    if ("timestamp" in item && item.timestamp !== undefined)
      return item.timestamp;
  }
  return undefined;
}

function lastTimestamp(items: TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && "timestamp" in item && item.timestamp !== undefined)
      return item.timestamp;
  }
  return undefined;
}

export function segmentRuns(
  items: TranscriptItem[],
  runActive: boolean,
): RunNode[] {
  const nodes: RunNode[] = [];
  let buffer: TranscriptItem[] = [];
  // What opened the run this buffer belongs to, so the span counts from when the
  // person asked rather than from the first tool that answered.
  let opener: TranscriptItem | null = null;

  const flush = (live: boolean): void => {
    // A live run opens its group before anything has streamed, so the header is
    // there from the moment the person sends rather than when the first tool lands.
    if (buffer.length === 0 && !live) return;
    if (buffer.length === 0 && opener === null) return;

    /* The answer is whatever prose a run trails off with, and it stands outside
       the group from its first token, so it never moves once the run ends. */
    const last = buffer[buffer.length - 1];
    const answer: AgentTextItem | ErrorTextItem | null =
      last?.kind === "agent_text" || last?.kind === "error_text" ? last : null;
    const nested = answer === null ? buffer : buffer.slice(0, -1);

    const startedAt = timestampOf(opener) ?? firstTimestamp(buffer);
    const endedAt = timestampOf(answer) ?? lastTimestamp(nested);
    const first = buffer[0] ?? opener;
    nodes.push({
      kind: "group",
      id: `group-${first === null ? "run" : transcriptItemKey(first)}`,
      items: nested,
      answer,
      live,
      ...(startedAt !== undefined && { startedAt }),
      ...(endedAt !== undefined && { endedAt }),
    });
    buffer = [];
  };

  for (const item of items) {
    if (opensRun(item)) {
      flush(false);
      opener = item;
      nodes.push({ kind: "item", item });
    } else if (nests(item)) {
      buffer.push(item);
    } else {
      // A divider, an error or a compaction interrupts the run's activity, so
      // it flushes what came before and stands on its own line.
      flush(false);
      opener = null;
      nodes.push({ kind: "item", item });
    }
  }
  // Only the final run can still be live.
  flush(runActive);
  return nodes;
}
