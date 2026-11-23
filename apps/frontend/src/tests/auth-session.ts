import type { QueryClient } from "@tanstack/react-query";
import { vi } from "vitest";

import { MockEventSource } from "./mockEventSource.js";
import { json, stubApi } from "./stubApi.js";
import type { ApiRequest } from "./stubApi.js";

export const GET_SESSION_PATH = "/api/auth/get-session";
const ORGANIZATION_PATH = "/api/organization";

// What every signed-in page reads beside the session: the organization the sidebar names.
function organizationBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Acme",
    logo: null,
    requireMfa: false,
    locked: {},
    ...overrides,
  };
}

// What Better Auth answers get-session with for a signed-in person.
export function sessionBody(
  user: { email?: string; name?: string; theme?: string } = {},
  role: string | null = "admin",
) {
  return {
    role,
    session: { id: "s1", token: "t" },
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

// The organization the sidebar names, which every signed-in page reads.
export function organizationAnswer(path: string): Response | undefined {
  return path === ORGANIZATION_PATH ? json(organizationBody()) : undefined;
}

// The two answers every signed-in page needs: its session, null for a stranger, and the organization.
export function signedInAnswer(
  path: string,
  session: unknown = sessionBody(),
): Response | undefined {
  return path === GET_SESSION_PATH ? json(session) : organizationAnswer(path);
}

/* A page rendered on its own, with the session its route would already have read.
   Kept past its last observer, since these clients collect unobserved data at once. */
export function signedIn(
  queryClient: QueryClient,
  role: string | null = "admin",
): QueryClient {
  // The key authSessionQuery holds, untyped so the body need not match Better Auth's own types.
  const queryKey = ["auth", "session"];
  queryClient.setQueryDefaults(queryKey, { gcTime: Infinity });
  queryClient.setQueryData(queryKey, sessionBody({}, role));
  return queryClient;
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
    if (request.path === GET_SESSION_PATH || signedIn) {
      const answered = signedInAnswer(
        request.path,
        signedIn ? sessionBody() : null,
      );
      if (answered !== undefined) return answered;
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
