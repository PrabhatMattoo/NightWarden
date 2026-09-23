import * as React from "react";

import { cn } from "@/shared/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-control border-hairline border-edge-input bg-transparent px-3 py-2 type-input highlight-motion placeholder:text-ink-faint hover:border-edge-input-hover disabled:text-ink-muted aria-invalid:border-fail",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
