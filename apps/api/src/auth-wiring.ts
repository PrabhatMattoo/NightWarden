import { initAuth } from "./auth/instance.js";
import { accessOf } from "./organization/organization-store.js";

// The one place auth/ learns what organization/ knows, so auth/ imports none of it.
export function wireAuth(): void {
  initAuth({ accessOf });
}
