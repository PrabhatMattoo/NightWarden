// The one surface every popup floats on and the one row every popup offers.

// Rung in its ground's solid edge, as a select list is; menus and popovers pass shadow-menu for the thin one.
export const OVERLAY_SURFACE =
  "origin-(--transform-origin) rounded-overlay bg-ground p-1 text-ink-base shadow-overlay outline-none duration-(--duration-fast) data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

/* An inset pill inside the popup's 4px padding. A menu highlights harder than a
   list does, since a menu is read by pointing at it; a plain link row lights the same. */
export const OVERLAY_OPTION =
  "relative flex h-8 w-full cursor-default items-center gap-2 rounded-control px-2 type-body text-ink-base no-underline select-none outline-none highlight-motion hover:bg-highlight focus-visible:bg-highlight data-highlighted:bg-highlight data-disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

// A group's name inside a popup, on the option's own inset so the two align.
export const OVERLAY_LABEL = "px-2 py-1 type-body text-ink-muted";

/* A tooltip is its opener's menu surface, not an inverted chip: base ink, its
   ground's plain edge over the low shadow. A chart's readout is drawn the same. */
export const TOOLTIP_SURFACE =
  "rounded-control border-hairline border-edge-base bg-ground px-2 py-1.5 type-small text-ink-base shadow-lift";

// Runs the popup's full width, through its padding.
export const OVERLAY_SEPARATOR = "-mx-1 my-1 border-t-hairline border-edge";

// A modal rests on the card ground above every popup, never wider than the page less 16px a side.
export const MODAL_SURFACE =
  "fixed inset-x-4 top-1/2 z-(--z-dialog) mx-auto grid -translate-y-1/2 rounded-overlay border-hairline border-edge-modal bg-ground p-6 text-ink-base shadow-modal outline-none duration-(--duration-fast) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

export const MODAL_BACKDROP =
  "fixed inset-0 isolate z-(--z-dialog-backdrop) bg-scrim duration-(--duration-fast) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0";
