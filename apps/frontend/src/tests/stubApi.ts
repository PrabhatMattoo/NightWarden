// The network boundary as the browser presents it: real Responses, whichever client asked.
import { vi } from "vitest";

export interface ApiRequest {
  // Path and query, as the server would route it.
  path: string;
  method: string;
  body: unknown;
  headers: Headers;
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

// The typed client hands over a Request and no init, so its method and body are read from it.
async function bodyOf(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  const text =
    typeof init?.body === "string"
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : "";
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

/* Answers each request through `route`. Anything it leaves unanswered is a 404
   naming the path, so a missing stub fails loudly rather than hanging. */
export function stubApi(
  route: (request: ApiRequest) => Response | Promise<Response> | undefined,
) {
  const log: ApiRequest[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request: ApiRequest = {
        path: pathOf(input),
        method: methodOf(input, init),
        body: await bodyOf(input, init),
        headers: headersOf(input, init),
      };
      log.push(request);
      return (
        (await route(request)) ??
        json({ error: `unstubbed ${request.path}` }, 404)
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
