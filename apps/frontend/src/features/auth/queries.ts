import { queryOptions } from "@tanstack/react-query";

import { apiQuery } from "@/shared/api/client";
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

interface DeviceSession {
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
