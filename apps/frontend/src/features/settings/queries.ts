import { queryOptions } from "@tanstack/react-query";
import type { AgentConfig } from "@nightwarden/shared";

import { apiFetch } from "@/shared/api/client";

export function configQuery() {
  return queryOptions({
    queryKey: ["config"],
    queryFn: () => apiFetch<AgentConfig>("/api/config"),
  });
}
