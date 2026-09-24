import type { LucideIcon } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { ICON_UI } from "@/shared/lib/iconProps";

/* A line of text led by an icon. The icon sits in a box one line tall, so it
   centres on the first line at any type size and however far the text wraps. */
function IconLine({
  icon: Icon,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { icon: LucideIcon }) {
  return (
    <div
      data-slot="icon-line"
      className={cn("flex items-start gap-2", className)}
      {...props}
    >
      <span className="flex h-lh shrink-0 items-center">
        <Icon {...ICON_UI} />
      </span>
      {children}
    </div>
  );
}

export { IconLine };
