import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api, apiQuery, dataOrThrow } from "@/shared/api/client";

export function configQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/config"));
}

export function mailQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/config/mail"));
}

export function organizationQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/organization"));
}

export function membersQuery() {
  return queryOptions(
    apiQuery.queryOptions("get", "/api/organization/members"),
  );
}

export function invitationsQuery() {
  return queryOptions(
    apiQuery.queryOptions("get", "/api/organization/invitations"),
  );
}

export function teamsQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/organization/teams"));
}

export function auditQuery() {
  return infiniteQueryOptions({
    queryKey: ["audit"],
    queryFn: ({ pageParam }) =>
      dataOrThrow(
        api.GET("/api/audit", { params: { query: { offset: pageParam } } }),
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
}
