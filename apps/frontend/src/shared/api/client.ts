// The frontend's single fetch boundary: one place for status handling, so a failure
// throws an ApiError react-query surfaces instead of a swallowed `if (!res.ok) return`.

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

// A failure throws, carrying the route's `error` or Better Auth's `message` as its text.
async function request(url: string, init?: RequestInit): Promise<Response> {
  const res = init === undefined ? await fetch(url) : await fetch(url, init);
  if (res.ok) return res;
  let message = `${init?.method ?? "GET"} ${url} failed (${res.status})`;
  let body: unknown;
  try {
    body = await res.json();
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
  throw new ApiError(res.status, message, body);
}

export async function apiText(
  url: string,
  init?: RequestInit,
): Promise<string> {
  return await (await request(url, init)).text();
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await request(url, init);
  if (res.status === 204) return undefined as T;
  try {
    // The one trusted cast in the frontend: responses are shape-checked at
    // compile time via @nightwarden/shared, a contract we own both ends of.
    return (await res.json()) as T;
  } catch {
    // A success with an empty or non-JSON body - the void endpoints (DELETE,
    // stop). Their callers type the result as void.
    return undefined as T;
  }
}
