// Reads what a stubbed fetch or socket was handed, the way the far end would read it.
import type { Mock } from "vitest";

export function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/* A body the test cannot read as text fails loudly, so a request sent in an
   unexpected shape is never matched against an empty string. */
export function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("the request carried a body the test cannot read as text");
}

export function urlsCalled(stub: Mock<typeof fetch>): string[] {
  return stub.mock.calls.map(([input]) => requestUrl(input));
}

export function frameText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  return new TextDecoder().decode(
    Array.isArray(raw) ? Buffer.concat(raw) : raw,
  );
}
