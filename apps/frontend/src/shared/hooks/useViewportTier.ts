import { useEffect, useState } from "react";

import { cssNumber } from "@/shared/lib/cssNumber";

// The md/lg breakpoint tokens, so the utilities and this hook read one source.
// Width, not orientation: a phone in landscape is 844x390 and cannot serve this.
const TABLET_MIN = cssNumber("--breakpoint-md", 768);
const DESKTOP_MIN = cssNumber("--breakpoint-lg", 1024);

type ViewportTier = "phone" | "tablet" | "desktop";

function tierFor(width: number): ViewportTier {
  if (width < TABLET_MIN) return "phone";
  return width < DESKTOP_MIN ? "tablet" : "desktop";
}

export function useViewportTier(): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(() =>
    tierFor(window.innerWidth),
  );

  useEffect(() => {
    function onResize(): void {
      setTier(tierFor(window.innerWidth));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return tier;
}
