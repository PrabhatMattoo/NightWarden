import * as React from "react";

import { cn } from "@/shared/lib/utils";

/* A control's fill on whatever ground holds it, held still rather than pulsing,
   and shown only once a wait outlasts a glance. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("rounded-control bg-control skeleton-reveal", className)}
      {...props}
    />
  );
}

export { Skeleton };
