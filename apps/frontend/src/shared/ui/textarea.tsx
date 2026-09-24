import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { unavailableProps } from "@/shared/ui/unavailable";

function Textarea({
  className,
  unavailable = false,
  disabled,
  ...props
}: React.ComponentProps<"textarea"> & {
  // Its text turns muted, where disabled alone only stops the pointer.
  unavailable?: boolean;
}) {
  return (
    <textarea
      data-slot="textarea"
      {...unavailableProps(unavailable, disabled)}
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-control border-hairline border-edge-input bg-transparent px-3 py-2 type-input highlight-motion placeholder:text-ink-faint hover:border-edge-input-hover aria-invalid:border-fail data-unavailable:text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
