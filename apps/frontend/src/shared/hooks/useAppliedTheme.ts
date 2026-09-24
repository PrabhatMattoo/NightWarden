import { useEffect } from "react";
import type { ThemePreference } from "@nightwarden/shared";

import { applyTheme, followSystem } from "@/shared/lib/appearance";

// Null until the account answers; the stored copy has already painted the page by then.
export function useAppliedTheme(theme: ThemePreference | null): void {
  useEffect(() => {
    if (theme === null) return;
    applyTheme(theme);
    return followSystem(theme);
  }, [theme]);
}
