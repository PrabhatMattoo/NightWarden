import React from "react";

import { cn } from "@/shared/lib/utils";

/* The one live line, and it holds one place: what the run is doing right now,
   whether that is the model working or the server waiting on something. */
export function WorkingIndicator({
  label,
  waiting = false,
}: {
  label: string;
  // Waiting on something outside the run, which breathes rather than sweeps.
  waiting?: boolean;
}): React.JSX.Element {
  return (
    <div
      className="animate-in fade-in type-prose duration-(--duration-slow)"
      role="status"
      data-testid="working-indicator"
    >
      <span className={cn(waiting ? "breathe text-ink-muted" : "live")}>
        {label}
      </span>
    </div>
  );
}
