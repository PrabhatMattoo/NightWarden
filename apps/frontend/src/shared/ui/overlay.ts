// The one surface every popup floats on and the one row every popup offers.

// Paired with data-ground="overlay", so everything inside re-derives on the popup.
export const OVERLAY_SURFACE =
  "origin-(--transform-origin) rounded-overlay bg-ground p-1 text-ink-base shadow-overlay outline-none duration-(--duration-fast) data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

/* An inset pill inside the popup's 4px padding. A menu highlights harder than a
   list does, since a menu is read by pointing at it. */
export const OVERLAY_OPTION =
  "relative flex h-8 w-full cursor-default items-center gap-2 rounded-control px-2 type-body text-ink-base select-none outline-none highlight-motion data-highlighted:bg-highlight data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

// A modal rests on the card ground above every popup, never wider than the page less 16px a side.
export const MODAL_SURFACE =
  "fixed inset-x-4 top-1/2 z-(--z-dialog) mx-auto grid -translate-y-1/2 rounded-overlay border-hairline border-edge-modal bg-ground p-6 text-ink-base shadow-modal outline-none duration-(--duration-fast) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

export const MODAL_BACKDROP =
  "fixed inset-0 isolate z-(--z-dialog-backdrop) bg-scrim duration-(--duration-fast) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0";
