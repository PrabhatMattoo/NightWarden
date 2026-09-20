import type { FrontendEvent } from "@nightwarden/shared";
import { transcriptItemKey } from "@nightwarden/shared";
import type { TranscriptItem } from "./types.js";

// False during a run means nothing is on screen yet, which is what puts the
// working animation there.
export function hasActiveStream(items: TranscriptItem[]): boolean {
  const last = items[items.length - 1];
  if (!last) return false;
  if (last.kind === "agent_text") return true;
  if (last.kind === "tool_call") return last.state.phase === "running";
  return false;
}

export function applyLiveEvent(
  items: TranscriptItem[],
  env: FrontendEvent,
  sessionId: string,
): TranscriptItem[] {
  if (env.type === "TEXT_MESSAGE_CONTENT") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;

    // The id the server will save this block under, so the streamed row and its
    // persisted twin share a key and the swap never remounts.
    const id = `assistant-${payload.turn}-${payload.block}`;

    const last = items[items.length - 1];
    if (last?.kind === "agent_text" && last.id === id) {
      return [
        ...items.slice(0, -1),
        { ...last, text: last.text + payload.delta },
      ];
    }
    return [
      ...items,
      { kind: "agent_text", id, text: payload.delta, turn: payload.turn },
    ];
  }

  // The API sends the finished card; the client inserts or replaces it by key
  // and never builds one itself, so a live card matches a reloaded one exactly.
  if (env.type === "TRANSCRIPT_ITEM") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;
    const key = transcriptItemKey(payload.item);
    const at = items.findIndex((item) => transcriptItemKey(item) === key);
    if (at === -1) return [...items, payload.item];
    return items.map((item, i) => (i === at ? payload.item : item));
  }

  // The retry re-streams the whole turn from the start, so drop the partial
  // text it produced before the transient error.
  if (env.type === "RUN_RETRYING") {
    if (env.payload.sessionId !== sessionId) return items;
    let end = items.length;
    while (end > 0 && items[end - 1]?.kind === "agent_text") end--;
    return end === items.length ? items : items.slice(0, end);
  }

  return items;
}
