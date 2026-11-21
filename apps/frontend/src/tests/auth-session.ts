import { vi } from "vitest";

import { MockEventSource } from "./mockEventSource.js";
import { json, stubApi } from "./stubApi.js";
import type { ApiRequest } from "./stubApi.js";

export const GET_SESSION_PATH = "/api/auth/get-session";

// What Better Auth answers get-session with for a signed-in person.
export function sessionBody(
  user: { email?: string; name?: string; theme?: string } = {},
) {
  return {
    session: { token: "t" },
    user: {
      id: "u1",
      email: "admin@example.com",
      name: "Admin",
      image: null,
      theme: "system",
      ...user,
    },
  };
}

/* A signed-out browser until the POST to `credentialPath` is answered, then a
   signed-in one with an empty app behind it, the way the server would. */
export function stubSigningIn({
  setupRequired,
  credentialPath,
  credentialAnswer,
  answer,
}: {
  setupRequired: boolean;
  credentialPath: string;
  credentialAnswer: () => Response;
  answer?: (request: ApiRequest) => Response | undefined;
}) {
  vi.stubGlobal("EventSource", MockEventSource);
  let signedIn = false;
  return stubApi((request) => {
    const custom = answer?.(request);
    if (custom !== undefined) return custom;
    if (request.path === GET_SESSION_PATH) {
      return json(signedIn ? sessionBody() : null);
    }
    if (request.path === "/api/setup" && request.method === "GET") {
      return json({ required: setupRequired });
    }
    if (request.path === credentialPath && request.method === "POST") {
      signedIn = true;
      return credentialAnswer();
    }
    if (request.path.startsWith("/api/sessions")) {
      return json({ rows: [], nextOffset: null, investigationTotal: 0 });
    }
    return undefined;
  });
}
