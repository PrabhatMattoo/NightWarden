import type { TranscriptItem } from "./schemas/transcript.js";

// Stable identity for a card, so a live update finds the item it belongs to.
export function transcriptItemKey(item: TranscriptItem): string {
  return "toolCallId" in item ? item.toolCallId : item.id;
}
