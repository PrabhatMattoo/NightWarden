"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "@/shared/lib/utils";
import { OVERLAY_SURFACE } from "@/shared/ui/overlay";
import { GroundProvider, useOverlayGround } from "@/shared/ui/ground";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  children,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const ground = useOverlayGround();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-(--z-overlay)"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          data-ground={ground}
          className={cn(
            OVERLAY_SURFACE,
            "z-(--z-overlay) flex w-72 flex-col gap-2.5 shadow-menu",
            className,
          )}
          {...props}
        >
          <GroundProvider ground={ground}>{children}</GroundProvider>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
