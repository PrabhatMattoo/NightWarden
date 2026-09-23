import * as React from "react";

import { cn } from "@/shared/lib/utils";

/* A panel resting on the stage: its own ground, an alpha ring and a drop rather
   than a border, so it reads the same on any ground beneath it. */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      data-ground="card"
      className={cn(
        "flex flex-col overflow-hidden rounded-card bg-ground text-ink-base shadow-card",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("p-4", className)} {...props} />
  );
}

export { Card, CardContent };
