import { queryOptions } from "@tanstack/react-query";
import { api, ApiError, dataOrThrow } from "@/shared/api/client";

// A 404 means nothing is recorded yet, never that the session is absent.
export function reportQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["report", sessionId],
    queryFn: () =>
      dataOrThrow(
        api.GET("/api/sessions/{id}/report", {
          params: { path: { id: sessionId } },
        }),
      ).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    // The report only changes via REPORT_UPDATED (plus the provider's reconnect
    // invalidation), so event-driven freshness is the model.
    staleTime: Infinity,
  });
}
