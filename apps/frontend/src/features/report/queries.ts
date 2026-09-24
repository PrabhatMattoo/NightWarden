import { queryOptions } from "@tanstack/react-query";
import type { SessionReportResponse } from "@nightwarden/shared";

import { apiFetch, ApiError } from "@/shared/api/client";

// A 404 means nothing is recorded yet, never that the session is absent.
export function reportQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["report", sessionId],
    queryFn: () =>
      apiFetch<SessionReportResponse>(
        `/api/sessions/${sessionId}/report`,
      ).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    // The report only changes via REPORT_UPDATED (plus the provider's reconnect
    // invalidation), so event-driven freshness is the model.
    staleTime: Infinity,
  });
}
