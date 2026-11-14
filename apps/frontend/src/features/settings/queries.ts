import { queryOptions } from "@tanstack/react-query";

import { apiQuery } from "@/shared/api/client";

export function configQuery() {
  return queryOptions(apiQuery.queryOptions("get", "/api/config"));
}
