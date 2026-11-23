import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";
import { unavailableProps } from "@/shared/ui/unavailable";

// Hover moves the fill and raises the ink one rung; disabled only stops the pointer, never dims.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-control border-hairline border-transparent bg-clip-padding type-item whitespace-nowrap select-none highlight-motion disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        default: "h-8 gap-2 px-3",
        sm: "h-7 gap-1.5 px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-8",
        "icon-sm": "size-7",
        // Inside a 24px chip, beside the text it removes.
        "icon-xs": "size-5 rounded-full [&_svg:not([class*='size-'])]:size-3",
      },
      variant: {
        default: "bg-accent text-on-accent shadow-lift hover:bg-accent-hover",
        secondary:
          "bg-control text-ink-base shadow-control hover:bg-control-hover hover:shadow-control-hover aria-expanded:bg-control-hover aria-expanded:text-ink-title aria-expanded:shadow-control-hover",
        outline:
          "border-edge-input text-ink-base hover:bg-ghost-hover aria-expanded:bg-ghost-hover",
        ghost:
          "text-ink-base hover:bg-ghost-hover hover:text-ink-title aria-expanded:bg-ghost-hover aria-expanded:text-ink-title",
        // Muted until pointed at: the icons in a page's bar.
        quiet:
          "text-ink-muted hover:bg-ghost-hover hover:text-ink-base aria-expanded:bg-ghost-hover aria-expanded:text-ink-base",
        destructive: "bg-fail-fill text-on-accent hover:bg-fail-fill-hover",
        // The irreversible action: red ink over its own faint red wash.
        "destructive-ghost": "text-fail hover:bg-fail-tint",
        link: "h-auto gap-1 p-0 type-body text-ink-title",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  unavailable = false,
  disabled,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    // Dims, where disabled alone only stops the pointer.
    unavailable?: boolean;
  }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      {...unavailableProps(unavailable, disabled)}
      className={cn(
        buttonVariants({ variant, size }),
        "data-unavailable:dim-control aria-disabled:dim-control",
        className,
      )}
      {...props}
    />
  );
}

export { Button, buttonVariants };
