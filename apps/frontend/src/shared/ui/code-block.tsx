import * as React from "react";

import { cn } from "@/shared/lib/utils";

// Quoted text, not a control: a quiet fill of its own ground and no edge.
function CodeBlock({ className, ...props }: React.ComponentProps<"pre">) {
  return (
    <pre
      data-slot="code-block"
      className={cn(
        "block overflow-auto rounded-control bg-control p-3 font-mono type-body break-all whitespace-pre-wrap",
        className,
      )}
      {...props}
    />
  );
}

export { CodeBlock };
