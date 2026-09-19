import type { FrontendEvent } from "@nightwarden/shared";
import { transcriptItemKey } from "@nightwarden/shared";
import type { TranscriptItem, ThinkingItem } from "./types.js";

// A non-thinking event closes the current thinking burst, so a later delta opens
// a fresh item. A whitespace-only burst is dropped rather than drawn empty.
function finalizeTrailingThinking(items: TranscriptItem[]): TranscriptItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "thinking" && last.streaming) {
    if (!last.text.trim()) return items.slice(0, -1);
    const finalized: ThinkingItem = { ...last, streaming: false };
    return [...items.slice(0, -1), finalized];
  }
  return items;
}

// False during a run means nothing is on screen yet, which is what puts the
// working animation there.
export function hasActiveStream(items: TranscriptItem[]): boolean {
  const last = items[items.length - 1];
  if (!last) return false;
  if (last.kind === "thinking")
    return last.streaming && last.text.trim() !== "";
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

    if (payload.kind === "thinking") {
      const last = items[items.length - 1];
      // Grow the block already open; a new block opens its own item, even when
      // the previous one was also reasoning.
      if (last?.kind === "thinking" && last.streaming && last.id === id) {
        return [
          ...items.slice(0, -1),
          { ...last, text: last.text + payload.delta },
        ];
      }
      const settled = finalizeTrailingThinking(items);
      return [
        ...settled,
        {
          kind: "thinking",
          id,
          text: payload.delta,
          streaming: true,
          turn: payload.turn,
        },
      ];
    }

    if (payload.kind !== "text") return items;

    const settled = finalizeTrailingThinking(items);
    const last = settled[settled.length - 1];
    if (last?.kind === "agent_text" && last.id === id) {
      return [
        ...settled.slice(0, -1),
        { ...last, text: last.text + payload.delta },
      ];
    }
    return [
      ...settled,
      { kind: "agent_text", id, text: payload.delta, turn: payload.turn },
    ];
  }

  // The API sends the finished card; the client inserts or replaces it by key
  // and never builds one itself, so a live card matches a reloaded one exactly.
  if (env.type === "TRANSCRIPT_ITEM") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;
    const settled = finalizeTrailingThinking(items);
    const key = transcriptItemKey(payload.item);
    const at = settled.findIndex((item) => transcriptItemKey(item) === key);
    if (at === -1) return [...settled, payload.item];
    return settled.map((item, i) => (i === at ? payload.item : item));
  }

  // The retry re-streams the whole turn from the start, so drop the partial
  // reasoning and text it produced before the transient error.
  if (env.type === "RUN_RETRYING") {
    if (env.payload.sessionId !== sessionId) return items;
    let end = items.length;
    while (end > 0) {
      const kind = items[end - 1]?.kind;
      if (kind === "agent_text" || kind === "thinking") end--;
      else break;
    }
    return end === items.length ? items : items.slice(0, end);
  }

  return items;
}
