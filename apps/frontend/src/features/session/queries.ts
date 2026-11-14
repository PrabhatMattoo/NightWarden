import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { SessionKind, StatusFilter } from "@nightwarden/shared";

import { api, apiQuery, dataOrThrow } from "@/shared/api/client";

export function sessionQuery(sessionId: string) {
  return queryOptions(
    apiQuery.queryOptions("get", "/api/sessions/{id}", {
      params: { path: { id: sessionId } },
    }),
  );
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
    queryFn: ({ pageParam }) =>
      dataOrThrow(
        api.GET("/api/sessions", {
          params: {
            query: {
              kind,
              offset: pageParam,
              ...(filter.status !== undefined && { status: filter.status }),
              ...(filter.q !== undefined && filter.q !== "" && { q: filter.q }),
            },
          },
        }),
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
}
