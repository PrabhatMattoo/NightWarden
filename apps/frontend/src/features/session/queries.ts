import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  SessionDetail,
  SessionKind,
  SessionListPage,
} from "@nightwarden/shared";

import { apiFetch } from "@/shared/api/client";

export function sessionQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["session", sessionId],
    queryFn: () => apiFetch<SessionDetail>(`/api/sessions/${sessionId}`),
  });
}

// One cache per kind. Investigations and chats are two pages over one table, so
// a shared cache would make either page's "load more" fetch the other's rows.
export function sessionsQueryKey(kind: SessionKind): readonly [string, string] {
  return ["sessions", kind] as const;
}

export function sessionsQuery(kind: SessionKind) {
  return infiniteQueryOptions({
    queryKey: sessionsQueryKey(kind),
    queryFn: ({ pageParam }) =>
      apiFetch<SessionListPage>(
        `/api/sessions?kind=${kind}&offset=${pageParam}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
}
