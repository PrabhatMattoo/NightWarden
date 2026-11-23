import { useSuspenseQuery } from "@tanstack/react-query";
import { ROLE_NAMES } from "@nightwarden/shared";
import type { RoleName } from "@nightwarden/shared";
import { isAllowed } from "@nightwarden/shared/permissions";
import type { Permission } from "@nightwarden/shared/permissions";

import { authSessionQuery } from "@/features/auth/queries";

/* The session's `role` is added server-side, so the client's own types do not
   know it. Null is a signed-out visitor, or an account that left the organization. */
export function roleOf(session: object | null): RoleName | null {
  if (session === null || !("role" in session)) return null;
  return ROLE_NAMES.find((name) => name === session.role) ?? null;
}

// The one place a screen asks what the signed-in person may do; none names a role.
export function useCan(permission: Permission): boolean {
  const { data: session } = useSuspenseQuery(authSessionQuery());
  return isAllowed(roleOf(session), permission);
}
