import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

const badgeVariants = cva(
  "inline-flex h-6 w-fit shrink-0 items-center gap-1 rounded-control bg-control px-2 type-small whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      // Muted is a value that stands as the default, apart from one a person chose.
      variant: { default: "text-ink-base", muted: "text-ink-muted" },
    },
    defaultVariants: { variant: "default" },
  },
);

// A quiet token of a value, never a status: status is a word in its tone.
function Badge({
  className,
  variant,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      { className: cn(badgeVariants({ variant, className })) },
      props,
    ),
    render,
    state: { slot: "badge" },
  });
}

export { Badge };
