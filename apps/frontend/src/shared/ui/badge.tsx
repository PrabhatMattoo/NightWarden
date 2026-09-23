import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "@/shared/lib/utils";

// A quiet token of a value, never a status: status is a word in its tone.
function Badge({
  className,
  render,
  ...props
}: useRender.ComponentProps<"span">) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(
          "inline-flex h-6 w-fit shrink-0 items-center gap-1 rounded-control bg-control px-2 type-small text-ink-base whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
          className,
        ),
      },
      props,
    ),
    render,
    state: { slot: "badge" },
  });
}

export { Badge };
