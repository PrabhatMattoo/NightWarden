import React from "react";

/* Shown while a run is active and nothing has reached the screen yet, which is
   the model generating: the word is what it is doing, and the sweep says it is
   still going. Three dots said only that something was happening. */
export function WorkingIndicator(): React.JSX.Element {
  return (
    <div
      className="animate-in fade-in duration-(--duration-slow) text-sm text-muted-foreground"
      role="status"
      data-testid="working-indicator"
    >
      <span className="shimmer">Thinking</span>
    </div>
  );
}
