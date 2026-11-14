// The frontend's single fetch boundary, typed by the API's own description: the
// path picks the request and response types, and a failure throws an ApiError.
import createFetchClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import type { paths } from "@nightwarden/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // The whole parsed body, not only the text lifted out of it: a caller that
    // must branch on a code needs the fields beside `error`.
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// The middleware below throws every failure as an ApiError, so the client is
// typed by each route's success answers alone and the query cache sees Error.
type Answered<Operation> = Operation extends { responses: infer Responses }
  ? Omit<Operation, "responses"> & {
      responses: Pick<
        Responses,
        Extract<keyof Responses, 200 | 201 | 202 | 204>
      >;
    }
  : Operation;
type SuccessPaths = {
  [Path in keyof paths]: {
    [Method in keyof paths[Path]]: Answered<paths[Path][Method]>;
  };
};

export const api = createFetchClient<SuccessPaths>({
  // A Request needs an absolute URL; the API shares the page's origin.
  baseUrl: window.location.origin,
  // The global is read per call rather than captured once, so a stubbed fetch is the one used.
  fetch: (request) => fetch(request),
});

// A failure throws, carrying the route's `error` or Better Auth's `message` as its text.
api.use({
  async onResponse({ request, response }) {
    if (response.ok) return;
    const path = new URL(request.url).pathname;
    let message = `${request.method} ${path} failed (${response.status})`;
    let body: unknown;
    try {
      body = await response.clone().json();
      if (typeof body === "object" && body !== null) {
        const text =
          "error" in body && typeof body.error === "string"
            ? body.error
            : "message" in body && typeof body.message === "string"
              ? body.message
              : undefined;
        if (text !== undefined) message = text;
      }
    } catch {
      // Non-JSON error body (or none); keep the status-based message.
    }
    throw new ApiError(response.status, message, body);
  },
});

export const apiQuery = createQueryClient(api);

// A failure has already thrown in the middleware, so what is left is the data.
export async function dataOrThrow<
  Answer extends { data?: unknown; error?: unknown },
>(pending: Promise<Answer>): Promise<Required<Answer>["data"]> {
  const answer = await pending;
  if ("error" in answer) throw answer.error;
  return answer.data;
}
