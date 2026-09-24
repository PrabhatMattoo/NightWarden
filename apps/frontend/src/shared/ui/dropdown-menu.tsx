"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/shared/lib/utils";
import { unavailableProps } from "@/shared/ui/unavailable";
import { OVERLAY_OPTION, OVERLAY_SURFACE } from "@/shared/ui/overlay";
import { GroundProvider, useOverlayGround } from "@/shared/ui/ground";

const DropdownMenu = MenuPrimitive.Root;

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  anchor,
  children,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) {
  const ground = useOverlayGround();
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="isolate z-(--z-overlay)"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          data-ground={ground}
          className={cn(
            OVERLAY_SURFACE,
            "min-w-40 overflow-hidden shadow-menu",
            className,
          )}
          {...props}
        >
          <GroundProvider ground={ground}>{children}</GroundProvider>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/* Destructive is a variant rather than a caller's className so that the one
   irreversible entry in a menu cannot be styled as an ordinary one. */
function DropdownMenuItem({
  className,
  variant = "default",
  unavailable = false,
  disabled,
  ...props
}: MenuPrimitive.Item.Props & {
  variant?: "default" | "destructive";
  // The row fades and its ink turns muted, where disabled alone only stops the pointer.
  unavailable?: boolean;
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      {...unavailableProps(unavailable, disabled)}
      className={cn(
        OVERLAY_OPTION,
        // An action menu's row rises to title ink under the pointer; a select list's keeps base.
        "whitespace-nowrap data-highlighted:text-ink-title data-[variant=destructive]:text-fail data-[variant=destructive]:data-highlighted:text-fail data-unavailable:text-ink-muted data-unavailable:dim-row",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 border-t-hairline border-edge", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
};
