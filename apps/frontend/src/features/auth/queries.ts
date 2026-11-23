import { queryOptions } from "@tanstack/react-query";

import { ApiError, api, apiQuery, dataOrThrow } from "@/shared/api/client";
import { authCall, authClient } from "@/shared/api/authClient";

// Changed only by signing in or out and by a 401 recheck, so it never goes stale on its own.
export function authSessionQuery() {
  return queryOptions({
    queryKey: ["auth", "session"],
    queryFn: () => authCall(authClient.getSession()),
    staleTime: Infinity,
  });
}

// Read only while signed out, to choose between the setup page and the login page.
export function setupQuery() {
  return queryOptions(
    apiQuery.queryOptions("get", "/api/setup", undefined, {
      staleTime: Infinity,
    }),
  );
}

// Read while signed out, to choose what the forgotten-password page offers.
export function signInOptionsQuery() {
  return queryOptions(
    apiQuery.queryOptions("get", "/api/sign-in-options", undefined, {
      staleTime: Infinity,
    }),
  );
}

/* What the invitation link shows before the person chooses a password. An
   unknown, cancelled or used token is one answer, so it reads as null. */
export function invitationQuery(token: string) {
  return queryOptions({
    queryKey: ["invitation", token],
    queryFn: () =>
      dataOrThrow(
        api.GET("/api/invitations/{token}", { params: { path: { token } } }),
      ).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
  });
}

interface DeviceSession {
  id: string;
  token: string;
  userAgent: string | null;
  // Moves when the session is refreshed, at most once a day, so it reads as roughly when.
  updatedAt: string;
}

// The IP address is left behind: the list names a device, not where it was.
export function devicesQuery() {
  return queryOptions({
    queryKey: ["auth", "devices"],
    queryFn: async (): Promise<DeviceSession[]> =>
      ((await authCall(authClient.listSessions())) ?? []).map((s) => ({
        id: s.id,
        token: s.token,
        userAgent: s.userAgent ?? null,
        updatedAt: new Date(s.updatedAt).toISOString(),
      })),
  });
}
