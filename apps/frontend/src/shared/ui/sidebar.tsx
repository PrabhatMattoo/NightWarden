import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { PanelLeftIcon } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { GroundProvider } from "@/shared/ui/ground";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openOverlay: boolean;
  setOpenOverlay: (open: boolean) => void;
  // Below lg the rail gives up its column and opens over the stage instead.
  isOverlay: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

function SidebarProvider({
  defaultOpen = true,
  overlay = false,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  /* Supplied by whoever mounts the rail, because a primitive that reads the
     viewport itself cannot be rendered at a size of the caller's choosing. */
  overlay?: boolean;
}) {
  const [openOverlay, setOpenOverlay] = React.useState(false);
  const [open, setOpenState] = React.useState(defaultOpen);

  const setOpen = React.useCallback((value: boolean) => {
    setOpenState(value);
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${value}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
  }, []);

  const toggleSidebar = React.useCallback(() => {
    if (overlay) setOpenOverlay((was) => !was);
    else setOpen(!open);
  }, [overlay, open, setOpen]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state: open ? "expanded" : "collapsed",
      open,
      setOpen,
      isOverlay: overlay,
      openOverlay,
      setOpenOverlay,
      toggleSidebar,
    }),
    [open, setOpen, overlay, openOverlay, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        className={cn("group/sidebar-wrapper flex min-h-svh w-full", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

// The rail runs the full window height on its own ground, and the stage sits flush beside it.
function Sidebar({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { isOverlay, state, openOverlay, setOpenOverlay } = useSidebar();

  if (isOverlay) {
    return (
      <Sheet open={openOverlay} onOpenChange={setOpenOverlay} {...props}>
        <SheetContent
          data-slot="sidebar"
          data-ground="sidebar"
          side="left"
          showCloseButton={false}
          className="w-sidebar-sheet gap-0 p-0 data-[side=left]:w-sidebar-sheet"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>Every section of NightWarden.</SheetDescription>
          </SheetHeader>
          <GroundProvider ground="sidebar">
            <div className="flex h-full w-full flex-col">{children}</div>
          </GroundProvider>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer hidden lg:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? "icon" : ""}
      data-slot="sidebar"
    >
      <div
        data-slot="sidebar-gap"
        className="relative w-sidebar transition-layout duration-(--duration-panel) ease-panel group-data-[collapsible=icon]:w-sidebar-icon"
      />
      <div
        data-slot="sidebar-container"
        data-ground="sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-(--z-rail) hidden h-svh w-sidebar border-r-hairline border-edge-faint bg-ground transition-layout duration-(--duration-panel) ease-panel group-data-[collapsible=icon]:w-sidebar-icon lg:flex",
          className,
        )}
        {...props}
      >
        <div data-slot="sidebar-inner" className="flex size-full flex-col">
          <GroundProvider ground="sidebar">{children}</GroundProvider>
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn("text-ink-muted", className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeftIcon strokeWidth={1.5} aria-hidden />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
}

function SidebarInset({
  className,
  children,
  ...props
}: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      data-ground="stage"
      className={cn(
        "relative flex w-full min-w-0 flex-1 flex-col bg-ground",
        className,
      )}
      {...props}
    >
      <GroundProvider ground="stage">{children}</GroundProvider>
    </main>
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex flex-col gap-2 p-3", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("flex flex-col gap-2 px-2 py-3", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "no-scrollbar flex min-h-0 flex-1 flex-col overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn(
        "relative flex w-full min-w-0 flex-col px-2 py-3",
        className,
      )}
      {...props}
    />
  );
}

// A group's name lines up with its rows' icons, in the rows' own type at rest.
function SidebarGroupLabel({
  className,
  ...props
}: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="sidebar-group-label"
      className={cn(
        "nav-label-motion mb-1.5 truncate ps-1.5 whitespace-nowrap type-item text-ink-muted",
        "group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-px", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

// One geometry open and closed, so only the rail's width moves.
const ROW_GEOMETRY =
  "flex h-7.5 w-full items-center overflow-hidden rounded-control text-left type-item";

// The selected fill holds under the pointer; only an unselected row answers hover.
const SIDEBAR_ROW = `group/menu-button ${ROW_GEOMETRY} px-1.5 text-ink-muted highlight-motion hover:bg-hover hover:text-ink-title disabled:pointer-events-none aria-disabled:pointer-events-none data-active:bg-selected data-active:text-ink-title data-active:hover:bg-selected [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5`;

function SidebarMenuButton({
  render,
  isActive = false,
  tooltip,
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    isActive?: boolean;
    tooltip?: string;
  }) {
  const { isOverlay, state } = useSidebar();
  const comp = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      { className: cn(SIDEBAR_ROW, className) },
      props,
    ),
    render: tooltip === undefined ? render : <TooltipTrigger render={render} />,
    state: { slot: "sidebar-menu-button", active: isActive },
  });

  if (tooltip === undefined) return comp;

  return (
    <Tooltip>
      {comp}
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isOverlay}
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/* A row that only shows something: no hover, and a 24px mark centred where an
   icon sits. Room is kept for its action while the rail is open. */
function SidebarMenuStatic({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-static"
      className={cn(
        ROW_GEOMETRY,
        "px-1 text-ink-base group-has-data-[slot=sidebar-menu-action]/menu-item:pe-8 group-data-[collapsible=icon]:pe-1",
        className,
      )}
      {...props}
    />
  );
}

// A second action at a row's end; the collapsed rail has no room for it.
function SidebarMenuAction({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="sidebar-menu-action"
      className={cn(
        "absolute inset-y-0 end-1 my-auto flex size-6 items-center justify-center rounded-control text-ink-muted highlight-motion hover:bg-ghost-hover hover:text-ink-title group-data-[collapsible=icon]:hidden [&>svg]:size-4 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

// The one child the rail collapses, and it says so itself.
function SidebarMenuLabel({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="sidebar-menu-label"
      className={cn(
        "nav-label-motion ms-2 min-w-0 flex-1 truncate whitespace-nowrap",
        "group-data-[collapsible=icon]:ms-0 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuLabel,
  SidebarMenuStatic,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
};
