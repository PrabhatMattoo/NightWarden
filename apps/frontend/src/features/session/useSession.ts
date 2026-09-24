import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FrontendEvent, SessionDetail } from "@nightwarden/shared";
import { useFrontendEvents } from "@/shared/events/FrontendEventsProvider.js";
import { sessionQuery } from "./queries";

// The alert list lives here rather than on the report, so without this an open
// record never learns that the condition recovered.
const REFRESHES: ReadonlySet<FrontendEvent["type"]> = new Set([
  "REPORT_UPDATED",
  "RUN_FINISHED",
  "RUN_STOPPED",
  "RUN_FAILED",
]);

// Both layout decisions read this, so neither infers a session's kind from the
// artifacts a run happened to produce.
export function useSession(sessionId: string | null): SessionDetail | null {
  const queryClient = useQueryClient();

  const handleEnvelope = useCallback(
    (env: FrontendEvent) => {
      // The heading reads this, and a title costs one field rather than a refetch.
      if (env.type === "SESSION_TITLE_UPDATED") {
        if (env.payload.sessionId !== sessionId) return;
        queryClient.setQueryData<SessionDetail>(
          sessionQuery(sessionId).queryKey,
          (prev) => (prev ? { ...prev, title: env.payload.title } : prev),
        );
        return;
      }
      if (!REFRESHES.has(env.type)) return;
      if (!("sessionId" in env.payload)) return;
      if (env.payload.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({
        queryKey: sessionQuery(sessionId).queryKey,
      });
    },
    [queryClient, sessionId],
  );
  useFrontendEvents(handleEnvelope);

  // Loaded by the route before the page renders; asked again only once stale.
  const { data = null } = useQuery({
    ...sessionQuery(sessionId ?? ""),
    enabled: sessionId !== null,
  });
  return data;
}
