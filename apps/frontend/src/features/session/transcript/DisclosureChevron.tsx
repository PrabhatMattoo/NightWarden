import { ChevronRight } from "lucide-react";

import { ICON_INLINE } from "@/shared/lib/iconProps";
import { cn } from "@/shared/lib/utils";

/* The mark on a row that opens. Hidden by colour rather than opacity: Safari
   gives an opacity transition its own layer and rounds it to a whole pixel. */
export function DisclosureChevron({
  openable = true,
}: {
  // A row with nothing to open yet keeps the slot so revealing it moves nothing.
  openable?: boolean;
}): React.JSX.Element {
  return (
    <ChevronRight
      {...ICON_INLINE}
      className={cn(
        "shrink-0 self-center text-transparent transition-[color,rotate] duration-(--duration-slow)",
        openable &&
          "group-hover:text-foreground group-aria-expanded:rotate-90 group-aria-expanded:text-foreground",
      )}
    />
  );
}
