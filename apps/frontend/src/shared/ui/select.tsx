"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { OVERLAY_OPTION, OVERLAY_SURFACE } from "@/shared/ui/overlay";
import { GroundProvider, useOverlayGround } from "@/shared/ui/ground";

const Select = SelectPrimitive.Root;

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  );
}

// A pick-from box is its fill and a lit ring, the opposite of a typed-in one, and hugs its option.
function SelectTrigger({
  className,
  size = "default",
  id,
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      id={id}
      aria-labelledby={
        props["aria-labelledby"] ??
        (id !== undefined && props["aria-label"] === undefined
          ? `${id}-label`
          : undefined)
      }
      className={cn(
        "flex w-fit max-w-full items-center justify-between gap-2 rounded-control border-hairline border-transparent bg-control bg-clip-padding pr-2 pl-3 type-body text-ink-base shadow-control whitespace-nowrap select-none highlight-motion hover:bg-control-hover disabled:pointer-events-none aria-invalid:border-fail data-[size=default]:h-7.5 data-[size=sm]:h-7 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon className="pointer-events-none size-4 text-ink-muted" />
        }
      />
    </SelectPrimitive.Trigger>
  );
}

// Lays the chosen row over its trigger; below it only where there is no room to.
function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const ground = useOverlayGround();
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-(--z-overlay)"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-ground={ground}
          className={cn(
            OVERLAY_SURFACE,
            "relative max-h-(--available-height) w-auto min-w-(--anchor-width) overflow-x-hidden overflow-y-auto p-0",
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="scroll-py-1 p-1">
            <GroundProvider ground={ground}>{children}</GroundProvider>
          </SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(OVERLAY_OPTION, "pr-8", className)}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-(--z-within) flex w-full cursor-default items-center justify-center bg-ground py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-(--z-within) flex w-full cursor-default items-center justify-center bg-ground py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
