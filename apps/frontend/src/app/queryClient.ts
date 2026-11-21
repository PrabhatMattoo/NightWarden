import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiError } from "@/shared/api/client";
import { authSessionQuery } from "@/features/auth/queries";

/* A 401 can be an upstream credential rejected, such as GitHub refusing a token,
   so the session is asked again rather than assumed gone. */
function recheckSession(client: QueryClient, error: Error): void {
  if (!(error instanceof ApiError) || error.status !== 401) return;
  const { queryKey } = authSessionQuery();
  if (!client.getQueryData(queryKey)) return;
  void client.refetchQueries({ queryKey, exact: true });
}

export function createQueryClient({ retry = true } = {}): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => recheckSession(client, error),
    }),
    mutationCache: new MutationCache({
      onError: (error) => recheckSession(client, error),
    }),
    defaultOptions: {
      queries: {
        // A page mounts right after its loader fetched; this keeps it from fetching twice.
        staleTime: 30_000,
        // A whole page waits on these, and a 4xx answers the same however often it is asked.
        retry: retry
          ? (failures, error) =>
              failures < 2 && !(error instanceof ApiError && error.status < 500)
          : false,
      },
    },
  });
  return client;
}
