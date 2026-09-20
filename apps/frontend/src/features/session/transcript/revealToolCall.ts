// From the report into the transcript: open the group holding a cited call, open
// the call, scroll to it. A held target, so a row mounting late still finds it.

import { cssNumber } from "@/shared/lib/cssNumber";

export const REVEAL_MS = cssNumber("--duration-reveal", 1600);

let target: string | null = null;
const listeners = new Set<() => void>();

export function revealToolCall(toolCallId: string): void {
  target = toolCallId;
  for (const notify of listeners) notify();
}

export function revealTarget(): string | null {
  return target;
}

export function onReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The revealed row clears itself once its highlight has run, so a later reveal
// of the same call lights it again.
export function endReveal(toolCallId: string): void {
  if (target === toolCallId) target = null;
}
