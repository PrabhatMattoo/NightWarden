/* A stored credential's health is read off the third party's own answer: only a
   typed refusal marks the row, and any accepted call clears it. */

import { GitHubApiError } from "./github.js";
import { LokiApiError } from "./loki.js";
import { MetricsApiError } from "./metrics/client.js";
import { SentryApiError } from "./sentry.js";
import { clearRejected, markRejected } from "./store.js";

// A refusal the same credential would meet on any request, never one a query caused.
export function isCredentialRejection(err: unknown): boolean {
  if (err instanceof GitHubApiError) {
    return err.code === "invalid_token" || err.code === "sso_required";
  }
  if (err instanceof SentryApiError) {
    return err.code === "unauthorized" || err.code === "forbidden";
  }
  if (err instanceof LokiApiError || err instanceof MetricsApiError) {
    return err.code === "unauthorized";
  }
  return false;
}

export async function withStoredCredential<T>(
  integrationId: string,
  call: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await call();
  } catch (err) {
    if (isCredentialRejection(err) && err instanceof Error) {
      markRejected(integrationId, err.message, new Date().toISOString());
    }
    throw err;
  }
  clearRejected(integrationId);
  return result;
}
