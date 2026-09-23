// The account holds the choice; this copy only lets the next load paint in it before the account answers.
import type { ThemePreference } from "@nightwarden/shared";

const STORAGE_KEY = "nightwarden.theme";
const PREFERS_LIGHT = "(prefers-color-scheme: light)";

export function applyTheme(preference: ThemePreference): void {
  const light =
    preference === "light" ||
    (preference === "system" && window.matchMedia(PREFERS_LIGHT).matches);
  document.documentElement.dataset["theme"] = light ? "light" : "dark";
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage refused (a private window): the account still holds the choice.
  }
}

// Follows the system while the choice is "system", so a change in the OS repaints at once.
export function followSystem(preference: ThemePreference): () => void {
  if (preference !== "system") return () => {};
  const query = window.matchMedia(PREFERS_LIGHT);
  const repaint = (): void => applyTheme("system");
  query.addEventListener("change", repaint);
  return () => query.removeEventListener("change", repaint);
}
