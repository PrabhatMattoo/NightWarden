// The network boundary as the browser presents it: real Responses, whichever client asked.
import { vi } from "vitest";

export interface ApiRequest {
  // Path and query, as the server would route it.
  path: string;
  method: string;
  body: unknown;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  const url =
    typeof input === "string"
      ? new URL(input, window.location.origin)
      : input instanceof URL
        ? input
        : new URL(input.url);
  return `${url.pathname}${url.search}`;
}

function bodyOf(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") return undefined;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return init.body;
  }
}

/* Answers each request through `route`. Anything it leaves unanswered is a 404
   naming the path, so a missing stub fails loudly rather than hanging. */
export function stubApi(
  route: (request: ApiRequest) => Response | Promise<Response> | undefined,
) {
  const log: ApiRequest[] = [];
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request: ApiRequest = {
        path: pathOf(input),
        method: (init?.method ?? "GET").toUpperCase(),
        body: bodyOf(init),
      };
      log.push(request);
      return Promise.resolve(
        route(request) ?? json({ error: `unstubbed ${request.path}` }, 404),
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    requests: (prefix: string): ApiRequest[] =>
      log.filter((request) => request.path.startsWith(prefix)),
  };
}
