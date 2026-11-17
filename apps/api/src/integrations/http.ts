// The one door for calls to third-party services; the AI SDK keeps its own.
// The caller's signal is the only bound, so a retry never outlives the call.

import ky, { isNetworkError } from "ky";
import { failureCode } from "./reachability.js";

const RETRY_LIMIT = 2;
const RETRY_STATUSES = [429, 502, 503, 504];
const TRANSIENT_CODES = ["ECONNRESET", "UND_ERR_SOCKET"];

/* Whether waiting may change the answer: a status the service uses for "not
   now", or a connection that dropped. An ApiError carries its status. */
export function isTransient(err: unknown): boolean {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? err.status
      : undefined;
  if (typeof status === "number" && RETRY_STATUSES.includes(status)) {
    return true;
  }
  const code = failureCode(err);
  return code !== null && TRANSIENT_CODES.includes(code);
}

const reads = ky.create({
  timeout: false,
  // Thrown only to trigger ky's retry; the last attempt hands its status back.
  throwHttpErrors: (status) => RETRY_STATUSES.includes(status),
  retry: {
    limit: RETRY_LIMIT,
    // Loki and Prometheus queries are reads sent as POST.
    methods: ["get", "post"],
    statusCodes: RETRY_STATUSES,
    afterStatusCodes: [429, 503],
    shouldRetry: ({ error }) =>
      isNetworkError(error) ? isTransient(error) : undefined,
  },
  hooks: {
    beforeRetry: [
      ({ retryCount }) =>
        retryCount === RETRY_LIMIT
          ? { options: { throwHttpErrors: false } }
          : undefined,
    ],
  },
});

const writes = ky.create({ timeout: false, throwHttpErrors: false, retry: 0 });

type BoundInit = RequestInit & { signal: AbortSignal };

export async function fetchRead(
  input: string | Request,
  init: BoundInit,
): Promise<Response> {
  return await reads(input, init);
}

// A write that failed on the way back may already have landed, so it is sent once.
export async function fetchWrite(
  input: string | Request,
  init: BoundInit,
): Promise<Response> {
  return await writes(input, init);
}
