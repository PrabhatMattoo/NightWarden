import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

// Rows share their ground; the separator between two runs the card's full width.
function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="list"
      data-slot="item-group"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  );
}

function ItemSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      data-slot="item-separator"
      className={cn("border-t-hairline border-edge", className)}
      {...props}
    />
  );
}

/* A row that navigates highlights with an inset pill rather than a full-bleed
   band, so its neighbours' dividers stay whole under the pointer. */
const itemVariants = cva(
  "group/item relative flex w-full items-center gap-4 text-left outline-none data-unavailable:*:dim-row [a]:highlight-motion [a]:before:pointer-events-none [a]:before:absolute [a]:before:inset-x-2 [a]:before:inset-y-0.5 [a]:before:-z-(--z-within) [a]:before:rounded-control [a]:hover:before:bg-hover [a]:focus-visible:before:bg-hover",
  {
    variants: {
      size: {
        default: "px-4 py-3.5",
        sm: "px-4 py-2.5",
        lg: "gap-6 p-4",
      },
      // A control too tall to sit beside its label drops below at full width.
      layout: {
        row: "",
        stacked: "flex-col items-stretch gap-2",
      },
    },
    defaultVariants: {
      size: "default",
      layout: "row",
    },
  },
);

function Item({
  className,
  size = "default",
  layout = "row",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        role: "listitem",
        className: cn("isolate", itemVariants({ size, layout, className })),
      },
      props,
    ),
    render,
    state: { slot: "item", size },
  });
}

function ItemMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-media"
      className={cn(
        "flex shrink-0 items-center justify-center self-start text-ink-muted [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-0.5 group-data-[size=lg]/item:gap-1",
        className,
      )}
      {...props}
    />
  );
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn("flex min-w-0 items-center gap-2 type-item", className)}
      {...props}
    />
  );
}

function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn("type-small text-pretty", className)}
      {...props}
    />
  );
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("ml-auto flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  );
}

export {
  Item,
  ItemMedia,
  ItemContent,
  ItemActions,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
};
