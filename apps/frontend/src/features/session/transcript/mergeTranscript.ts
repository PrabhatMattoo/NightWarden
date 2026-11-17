import { transcriptItemKey } from "@nightwarden/shared";
import type { TranscriptItem } from "./types.js";

/* Lifted out of the column because the parent decides which items dock above
   the input, and it cannot pick from a list it never sees. */

interface MergeInput {
  persisted: TranscriptItem[];
  live: TranscriptItem[];
  // What the user just sent, under the id they minted for it.
  pendingEcho: { id: string; text: string } | null;
}

export function mergeTranscript({
  persisted,
  live,
  pendingEcho,
}: MergeInput): TranscriptItem[] {
  // Drawn until the transcript holds a turn under its id, and the saved copy
  // then takes its key, so the swap mounts nothing.
  const echo: TranscriptItem[] =
    pendingEcho !== null &&
    !persisted.some(
      (item) => item.kind === "user_turn" && item.id === pendingEcho.id,
    )
      ? [{ kind: "user_turn", id: pendingEcho.id, text: pendingEcho.text }]
      : [];

  // A streamed turn lives only until the transcript holds it. Derived, so the
  // two can never both be drawn and there is no window where neither is.
  const savedTurns = new Set(
    persisted.flatMap((item) => ("turn" in item ? [item.turn] : [])),
  );
  const streaming = live.filter(
    (item) => !("turn" in item) || !savedTurns.has(item.turn),
  );

  // Live events update the fetched list in place rather than competing with it:
  // a card can be replaced by a newer version of itself, never discarded.
  const merged = [...persisted, ...echo];
  for (const item of streaming) {
    const key = transcriptItemKey(item);
    const at = merged.findIndex((seen) => transcriptItemKey(seen) === key);
    if (at === -1) merged.push(item);
    else merged[at] = item;
  }
  return merged;
}
