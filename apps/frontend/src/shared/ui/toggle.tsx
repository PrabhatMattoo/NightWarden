import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";

import { cn } from "@/shared/lib/utils";

// Pressed is a lift, not a colour: the ink rises and the fill moves with it.
const TOGGLE =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-control px-2.5 type-body text-ink-muted whitespace-nowrap select-none highlight-motion hover:text-ink-title disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-control-hover data-pressed:text-ink-title [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function Toggle({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(TOGGLE, className)}
      {...props}
    />
  );
}

export { Toggle, TOGGLE };
