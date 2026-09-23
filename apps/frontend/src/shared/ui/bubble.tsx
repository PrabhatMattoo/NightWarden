import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "@/shared/lib/utils";

// A person's message: an object standing on the stage, at the transcript's reading size.
function Bubble({
  align = "end",
  className,
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="bubble"
      data-align={align}
      className={cn(
        "group/bubble relative flex w-fit max-w-4/5 min-w-0 flex-col gap-1 data-[align=end]:self-end",
        className,
      )}
      {...props}
    />
  );
}

function BubbleContent({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "w-fit max-w-full min-w-0 overflow-hidden rounded-card bg-control px-3 py-2 type-prose wrap-break-word group-data-[align=end]/bubble:self-end",
          className,
        ),
      },
      props,
    ),
    render,
    state: { slot: "bubble-content" },
  });
}

export { Bubble, BubbleContent };
