import { initAuth } from "./auth/instance.js";
import {
  accessOf,
  readOrganization,
} from "./organization/organization-store.js";

// The one place auth/ learns what organization/ knows, so auth/ imports none of it.
export function wireAuth(): void {
  // An authenticator lists the account under the organization's name.
  initAuth({ accessOf, mfaIssuer: () => readOrganization()?.name });
}
