import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { AlertSourceKind, GitHubRepoPage } from "@nightwarden/shared";

import { api, apiQuery, dataOrThrow } from "@/shared/api/client";

/* Every status here is read from the API's own database, never from the third
   party, so the catalog and each detail page can share them. */

export function githubStatusQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/integrations/github"));
}

// The API host's own sandbox check. Advisory: an unreachable check reads as no issue, never as a block.
export function githubPreflightQuery() {
  return queryOptions({
    queryKey: ["integrations", "github", "preflight"],
    queryFn: () =>
      dataOrThrow(api.POST("/api/integrations/github/preflight")).catch(
        () => null,
      ),
    staleTime: "static",
  });
}

/* The repositories a token reaches, asked of GitHub itself through the API, a
   page at a time. A POST, so the token never rides a URL. */
export function fetchGitHubRepos(
  page: number,
  token?: string,
): Promise<GitHubRepoPage> {
  return dataOrThrow(
    api.POST("/api/integrations/github/repos", {
      body: token === undefined ? { page } : { token, page },
    }),
  );
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
  return queryOptions(
    apiQuery.queryOptions("get", "/api/integrations/alerting/{kind}", {
      params: { path: { kind } },
    }),
  );
}

// One source across every metrics product, so one status answers all of them.
export function metricsSourceQuery() {
  return queryOptions(
    apiQuery.queryOptions("get", "/api/integrations/metrics"),
  );
}

export function lokiStatusQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/integrations/loki"));
}

export function sentryStatusQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/integrations/sentry"));
}

export function runnersQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/runners"));
}
