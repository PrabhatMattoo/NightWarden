import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";

import { cn } from "@/shared/lib/utils";
import { TOGGLE } from "@/shared/ui/toggle";

// A segmented choice on one control's fill; in a card the card bounds it.
function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(
        "inline-flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-control bg-control p-0.5 shadow-control no-scrollbar",
        className,
      )}
      {...props}
    />
  );
}

// An icon item is square and carries its name in aria-label and a tooltip.
function ToggleGroupItem({
  className,
  size = "default",
  ...props
}: TogglePrimitive.Props & { size?: "default" | "icon" }) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        TOGGLE,
        "data-pressed:shadow-control",
        size === "icon" && "w-7 px-0",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
