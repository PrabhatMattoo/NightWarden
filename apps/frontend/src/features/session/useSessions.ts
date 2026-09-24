import { useCallback } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  FrontendEvent,
  QueueState,
  SessionKind,
  SessionListPage,
  SessionListRow,
} from "@nightwarden/shared";
import { useFrontendEvents } from "@/shared/events/FrontendEventsProvider.js";
import { sessionsQuery, sessionsQueryKey } from "./queries";

type Pages = InfiniteData<SessionListPage, number>;

interface UseSessionsResult {
  sessions: SessionListRow[];
  // Answered by the server over every investigation, so a record's place in the
  // queue neither climbs as the user scrolls nor reads zero on a fresh page.
  investigationTotal: number;
  // Null until the first page lands, so the band draws nothing rather than
  // claiming an empty queue it has not been told about.
  queue: QueueState | null;
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

// Pages are fetched at fixed offsets, so a session that moves between fetches
// can land on two of them. First position wins; it never renders twice.
function dedupe(rows: SessionListRow[]): SessionListRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.sessionId)) return false;
    seen.add(row.sessionId);
    return true;
  });
}

export function useSessions(kind: SessionKind): UseSessionsResult {
  const queryClient = useQueryClient();
  /* A title is refined in the background moments after a session opens, so the
     list it belongs to takes the new one as it lands. */
  const onEvent = useCallback(
    (env: FrontendEvent) => {
      if (env.type !== "SESSION_TITLE_UPDATED") return;
      renameSession(
        queryClient,
        kind,
        env.payload.sessionId,
        env.payload.title,
      );
    },
    [queryClient, kind],
  );
  useFrontendEvents(onEvent);

  const query = useInfiniteQuery(sessionsQuery(kind));

  const first = query.data?.pages[0];
  return {
    // The API owns the sort of the set; the page arranges what is on screen,
    // because status is derived from a dispatcher SQL cannot see.
    sessions: dedupe(query.data?.pages.flatMap((page) => page.rows) ?? []),
    investigationTotal: first?.investigationTotal ?? 0,
    queue: first?.queue ?? null,
    isLoading: query.isLoading,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

function updatePages(
  queryClient: QueryClient,
  kind: SessionKind,
  update: (pages: SessionListPage[]) => SessionListPage[],
): void {
  queryClient.setQueryData<Pages>(sessionsQueryKey(kind), (prev) =>
    prev === undefined ? prev : { ...prev, pages: update(prev.pages) },
  );
}

// A session just started belongs at the top of the first page, where the API
// would put it. Before that page loads there is nothing to prepend to.
export function prependSession(
  queryClient: QueryClient,
  row: SessionListRow,
): void {
  updatePages(
    queryClient,
    row.investigation ? "investigation" : "chat",
    (pages) =>
      pages.map((page, index) =>
        index === 0 ? { ...page, rows: [row, ...page.rows] } : page,
      ),
  );
}

export function removeSession(
  queryClient: QueryClient,
  kind: SessionKind,
  sessionId: string,
): void {
  updatePages(queryClient, kind, (pages) =>
    pages.map((page) => ({
      ...page,
      rows: page.rows.filter((row) => row.sessionId !== sessionId),
    })),
  );
}

export function renameSession(
  queryClient: QueryClient,
  kind: SessionKind,
  sessionId: string,
  title: string,
): void {
  updatePages(queryClient, kind, (pages) =>
    pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) =>
        row.sessionId === sessionId ? { ...row, title } : row,
      ),
    })),
  );
}
