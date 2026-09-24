import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  AlertSourceKind,
  AlertSourceStatus,
  GitHubIntegrationStatus,
  GitHubRepoPage,
  LokiIntegrationStatus,
  MetricsSourceStatus,
  RunnerRecord,
  SentryIntegrationStatus,
} from "@nightwarden/shared";

import { apiFetch } from "@/shared/api/client";

/* Every status here is read from the API's own database, never from the third
   party, so the catalog and each detail page can share them. */

export function githubStatusQuery() {
  return queryOptions({
    queryKey: ["integrations", "github", "status"],
    queryFn: () =>
      apiFetch<GitHubIntegrationStatus>("/api/integrations/github"),
  });
}

// The API host's own sandbox check. Advisory: an unreachable check reads as no issue, never as a block.
export function githubPreflightQuery() {
  return queryOptions({
    queryKey: ["integrations", "github", "preflight"],
    queryFn: () =>
      apiFetch<{ ok: boolean; reason?: string }>(
        "/api/integrations/github/preflight",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      ).catch(() => null),
    staleTime: "static",
  });
}

/* The repositories a token reaches, asked of GitHub itself through the API, a
   page at a time. A POST, so the token never rides a URL. */
export function fetchGitHubRepos(
  page: number,
  token?: string,
): Promise<GitHubRepoPage> {
  return apiFetch<GitHubRepoPage>("/api/integrations/github/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token === undefined ? { page } : { token, page }),
  });
}

// The stored credential's list, or the list a typed token has just validated.
export function githubReposQuery(source: "stored" | "typed", token?: string) {
  return infiniteQueryOptions({
    queryKey: ["integrations", "github", "repos", source],
    queryFn: ({ pageParam }) => fetchGitHubRepos(pageParam, token),
    initialPageParam: 1,
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.length + 1 : undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

// Keyed by kind: two senders hold two credentials, and neither's delivery proof stands for the other.
export function alertSourceQuery(kind: AlertSourceKind) {
  return queryOptions({
    queryKey: ["integrations", "alerting", kind],
    queryFn: () =>
      apiFetch<AlertSourceStatus>(`/api/integrations/alerting/${kind}`),
  });
}

// One source across every metrics product, so one status answers all of them.
export function metricsSourceQuery() {
  return queryOptions({
    queryKey: ["integrations", "metrics"],
    queryFn: () => apiFetch<MetricsSourceStatus>("/api/integrations/metrics"),
  });
}

export function lokiStatusQuery() {
  return queryOptions({
    queryKey: ["integrations", "loki"],
    queryFn: () => apiFetch<LokiIntegrationStatus>("/api/integrations/loki"),
  });
}

export function sentryStatusQuery() {
  return queryOptions({
    queryKey: ["integrations", "sentry"],
    queryFn: () =>
      apiFetch<SentryIntegrationStatus>("/api/integrations/sentry"),
  });
}

export function runnersQuery() {
  return queryOptions({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
  });
}
