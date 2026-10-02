import { createContext, useContext } from "react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";
import { TOGGLE } from "@/shared/ui/toggle";

/* A track sets one choice among a few on a single fill, as a setting does. Pills
   switch the view of a list: each stands apart as a control, the chosen one lifted. */
const groupVariants = cva("inline-flex w-fit max-w-full items-center", {
  variants: {
    variant: {
      track:
        "gap-0.5 overflow-x-auto rounded-control bg-control p-0.5 shadow-control no-scrollbar",
      // Wraps rather than scrolls: a scroller clips the ring each pill draws outside its box.
      pills: "flex-wrap gap-2",
    },
  },
  defaultVariants: { variant: "track" },
});

type Variant = NonNullable<VariantProps<typeof groupVariants>["variant"]>;

const itemVariants = cva("", {
  variants: {
    variant: {
      track: [TOGGLE, "data-pressed:shadow-control"],
      pills:
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full bg-control px-2.5 type-chip text-ink-muted shadow-control whitespace-nowrap select-none highlight-motion hover:bg-ghost-hover hover:text-ink-base data-pressed:bg-selected data-pressed:text-ink-title data-pressed:hover:bg-selected data-pressed:hover:text-ink-title disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    },
  },
  defaultVariants: { variant: "track" },
});

const VariantContext = createContext<Variant>("track");

function ToggleGroup({
  className,
  variant = "track",
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof groupVariants>) {
  const resolved = variant ?? "track";
  return (
    <VariantContext.Provider value={resolved}>
      <ToggleGroupPrimitive
        data-slot="toggle-group"
        data-variant={resolved}
        className={cn(groupVariants({ variant: resolved, className }))}
        {...props}
      />
    </VariantContext.Provider>
  );
}

// An icon item is square and carries its name in aria-label and a tooltip.
function ToggleGroupItem({
  className,
  size = "default",
  ...props
}: TogglePrimitive.Props & { size?: "default" | "icon" }) {
  const variant = useContext(VariantContext);
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        itemVariants({ variant }),
        size === "icon" && "w-7 px-0",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
