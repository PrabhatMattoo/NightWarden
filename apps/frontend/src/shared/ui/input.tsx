import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/shared/lib/utils";

// Width is a fact about the value, not the page: a box sized for a secret
// promises room a tenant or a region can never use.
const MEASURE = {
  column: "w-full",
  beside: "w-full sm:w-control",
  short: "w-full max-w-control-sm",
  field: "w-full max-w-field",
} as const;

// A typed-in box is its edge: no fill, so it never reads as a dropdown.
const FIELD =
  "h-8 min-w-0 rounded-control border-hairline border-edge-input bg-transparent px-3 type-input highlight-motion placeholder:text-ink-faint hover:border-edge-input-hover disabled:pointer-events-none disabled:text-ink-muted aria-invalid:border-fail file:inline-flex file:h-6 file:border-0 file:bg-transparent file:type-item";

function Input({
  className,
  type,
  measure = "column",
  ...props
}: React.ComponentProps<"input"> & { measure?: keyof typeof MEASURE }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(FIELD, MEASURE[measure], className)}
      {...props}
    />
  );
}

export { Input };
