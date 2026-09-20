import React from "react";

/* The one live line, and it holds one place: what the run is doing right now,
   whether that is the model generating or the server preparing a sandbox. */
export function WorkingIndicator({
  label,
}: {
  label: string;
}): React.JSX.Element {
  return (
    <div
      className="animate-in fade-in duration-(--duration-slow) text-sm text-muted-foreground"
      role="status"
      data-testid="working-indicator"
    >
      <span className="shimmer">{label}</span>
    </div>
  );
}
