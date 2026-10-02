import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  SessionDetail,
  SessionKind,
  SessionListPage,
  StatusFilter,
} from "@nightwarden/shared";

import { apiFetch } from "@/shared/api/client";

export function sessionQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["session", sessionId],
    queryFn: () => apiFetch<SessionDetail>(`/api/sessions/${sessionId}`),
  });
}

// What a list is narrowed to. Empty is the whole list, which the route loads.
export interface SessionsFilter {
  status?: StatusFilter;
  q?: string;
}

// Every list of one kind, filtered or not, so invalidating it reaches them all.
// Investigations and chats are two pages over one table and never share a cache.
export function sessionsQueryKey(kind: SessionKind): readonly [string, string] {
  return ["sessions", kind] as const;
}

export function sessionsQuery(kind: SessionKind, filter: SessionsFilter = {}) {
  return infiniteQueryOptions({
    queryKey: [...sessionsQueryKey(kind), filter] as const,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ kind, offset: String(pageParam) });
      if (filter.status !== undefined) params.set("status", filter.status);
      if (filter.q !== undefined && filter.q !== "") params.set("q", filter.q);
      return apiFetch<SessionListPage>(`/api/sessions?${params.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
}
