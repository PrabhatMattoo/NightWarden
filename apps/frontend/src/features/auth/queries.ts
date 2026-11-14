import { queryOptions } from "@tanstack/react-query";
import type { AuthStatusResponse } from "@nightwarden/shared";

import { apiQuery } from "@/shared/api/client";
import { authCall, authClient } from "@/shared/api/authClient";

export type SignedIn = Extract<AuthStatusResponse, { authenticated: true }>;

// What a failed status check falls back to: the login page, never an endless load.
export const SIGNED_OUT: AuthStatusResponse = {
  ownerExists: true,
  authenticated: false,
};

export function isSignedIn(status: AuthStatusResponse): status is SignedIn {
  return status.ownerExists && status.authenticated;
}

// Changed only by signing in or out and by a 401 recheck, so it never goes stale on its own.
export function authStatusQuery() {
  return queryOptions(
    apiQuery.queryOptions("get", "/api/auth-status", undefined, {
      staleTime: Infinity,
    }),
  );
}

export interface DeviceSession {
  token: string;
  userAgent: string | null;
  createdAt: string;
}

// The IP address is left behind: the list names a device, not where it was.
export function devicesQuery() {
  return queryOptions({
    queryKey: ["auth", "devices"],
    queryFn: async (): Promise<DeviceSession[]> =>
      ((await authCall(authClient.listSessions())) ?? []).map((s) => ({
        token: s.token,
        userAgent: s.userAgent ?? null,
        createdAt: new Date(s.createdAt).toISOString(),
      })),
  });
}
