import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FrontendEvent, SessionReportResponse } from "@nightwarden/shared";
import { useFrontendEvents } from "@/shared/events/FrontendEventsProvider.js";
import { reportQuery } from "./queries";

// REPORT_UPDATED invalidates and the provider's reconnect heals a missed event.
export function useSessionReport(
  sessionId: string | null,
): SessionReportResponse | null {
  const queryClient = useQueryClient();

  const handleEnvelope = useCallback(
    (env: FrontendEvent) => {
      if (env.type !== "REPORT_UPDATED") return;
      if (env.payload.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({
        queryKey: reportQuery(sessionId).queryKey,
      });
    },
    [queryClient, sessionId],
  );
  useFrontendEvents(handleEnvelope);

  const { data = null } = useQuery({
    ...reportQuery(sessionId ?? ""),
    enabled: sessionId !== null,
  });

  return data;
}
