import { useCallback } from "react";
import {
  hashKey,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { FILTER_STATUSES } from "@nightwarden/shared";
import type {
  FrontendEvent,
  QueueState,
  SessionKind,
  SessionListPage,
  SessionListRow,
} from "@nightwarden/shared";
import { useFrontendEvents } from "@/shared/events/FrontendEventsProvider.js";
import {
  sessionsQuery,
  sessionsQueryKey,
  type SessionsFilter,
} from "./queries";

type Pages = InfiniteData<SessionListPage, number>;

/* The rows the whole list already holds that a narrower one would, shown while the
   server answers, so switching never flashes a row the filter leaves out. */
function narrowedFromWhole(
  queryClient: QueryClient,
  kind: SessionKind,
  filter: SessionsFilter,
): Pages | undefined {
  const q = filter.q?.toLowerCase() ?? "";
  if (filter.status === undefined && q === "") return undefined;
  const whole = queryClient.getQueryData<Pages>(sessionsQuery(kind).queryKey);
  if (whole === undefined) return undefined;
  const statuses =
    filter.status === undefined ? null : FILTER_STATUSES[filter.status];
  const keeps = (row: SessionListRow): boolean =>
    (statuses === null ||
      (row.status !== null && statuses.includes(row.status))) &&
    row.title.toLowerCase().includes(q);
  return {
    ...whole,
    pages: whole.pages.map((page) => ({
      ...page,
      rows: page.rows.filter(keeps),
      nextOffset: null,
    })),
  };
}

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

export function useSessions(
  kind: SessionKind,
  filter: SessionsFilter = {},
): UseSessionsResult {
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

  const query = useInfiniteQuery({
    ...sessionsQuery(kind, filter),
    placeholderData: () => narrowedFromWhole(queryClient, kind, filter),
  });

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

// Every cached list of the kind, filtered or not, since a row can sit in several.
function updatePages(
  queryClient: QueryClient,
  kind: SessionKind,
  update: (pages: SessionListPage[]) => SessionListPage[],
): void {
  queryClient.setQueriesData<Pages>(
    { queryKey: sessionsQueryKey(kind) },
    (prev) =>
      prev === undefined ? prev : { ...prev, pages: update(prev.pages) },
  );
}

/* A session just started belongs at the top of the whole list, where the API
   would put it. A filtered list may not hold it, so it is asked again instead. */
export function prependSession(
  queryClient: QueryClient,
  row: SessionListRow,
): void {
  const kind = row.investigation ? "investigation" : "chat";
  const whole = sessionsQuery(kind).queryKey;
  queryClient.setQueryData<Pages>(whole, (prev) =>
    prev === undefined
      ? prev
      : {
          ...prev,
          pages: prev.pages.map((page, index) =>
            index === 0 ? { ...page, rows: [row, ...page.rows] } : page,
          ),
        },
  );
  void queryClient.invalidateQueries({
    queryKey: sessionsQueryKey(kind),
    predicate: (query) => query.queryHash !== hashKey(whole),
    refetchType: "none",
  });
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
