"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

const FOCUS_RING =
  "has-[[data-slot=input-group-control]:focus-visible]:outline-1 has-[[data-slot=input-group-control]:focus-visible]:outline-focus has-[[data-slot=input-group-control]:focus-visible]:-outline-offset-1";

/* A field is its edge; a row is a chosen option opened into a field; the
   composer is a recessed object with a lit rim that takes the focus outline too. */
const inputGroupVariants = cva("", {
  variants: {
    variant: {
      field: FOCUS_RING,
      row: `h-auto border-transparent bg-control py-1 hover:border-transparent ${FOCUS_RING}`,
      composer: `edge-lit h-auto rounded-card border-0 bg-shade shadow-lift p-1 ${FOCUS_RING} *:data-[slot=input-group-control]:px-2 *:data-[slot=input-group-control]:pt-2 *:data-[slot=input-group-control]:type-prose`,
    },
  },
  defaultVariants: { variant: "field" },
});

function InputGroup({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupVariants>) {
  return (
    <div
      data-slot="input-group"
      // The composer's contents read on the card ground, over its own recessed fill.
      data-ground={variant === "composer" ? "card" : undefined}
      role="group"
      className={cn(
        // The group is the field, so it takes the edge and the focus for its input.
        "group/input-group relative flex h-8 min-w-0 items-center rounded-control border-hairline border-edge-input highlight-motion hover:border-edge-input-hover has-disabled:border-edge has-[[data-slot][aria-invalid=true]]:border-fail has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pr-2 has-[>[data-align=inline-start]]:[&>input]:pl-2",
        inputGroupVariants({ variant }),
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1 type-body text-ink-muted select-none group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-control [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start": "order-first pl-2 has-[>button]:-ml-1 has-[>kbd]:-ml-1",
        "inline-end": "order-last pr-2 has-[>button]:-mr-1 has-[>kbd]:-mr-1",
        "block-start":
          "order-first w-full justify-start px-3 pt-2 group-has-[>input]/input-group:pt-2 [.border-b-hairline]:pb-2",
        "block-end":
          "order-last w-full justify-start px-3 pb-2 group-has-[>input]/input-group:pb-2 [.border-t-hairline]:pt-2",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return;
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

// The one place a 24px control is right, which is why Button does not carry
// that rung: a control inside a 32px field cannot be 32px itself.
const inputGroupButtonVariants = cva("flex items-center gap-2", {
  variants: {
    size: {
      xs: "h-6 gap-1 px-2 [&>svg:not([class*='size-'])]:size-3.5",
      "icon-xs": "size-6 p-0 has-[>svg]:p-0",
      // Round, and a neutral fill until there is something to send.
      send: "size-6 rounded-full p-0 has-[>svg]:p-0 disabled:bg-control disabled:text-ink-base [&_svg:not([class*='size-'])]:size-3.5",
      icon: "size-8 p-0 has-[>svg]:p-0",
      default: "",
    },
  },
  defaultVariants: {
    size: "xs",
  },
});

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: "button" | "submit" | "reset";
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 type-body text-ink-muted [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "flex-1 rounded-none border-0 bg-transparent outline-none",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupTextarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "flex-1 resize-none rounded-none border-0 bg-transparent py-2 outline-none",
        className,
      )}
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
};
