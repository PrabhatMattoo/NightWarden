import { act, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  GET_SESSION_PATH,
  organizationAnswer,
  sessionBody,
} from "./auth-session.js";
import { renderApp } from "./renderWithProviders.js";
import { json, stubApi } from "./stubApi.js";
import type { ApiRequest } from "./stubApi.js";
import { MockEventSource } from "./mockEventSource.js";
import { runnersQuery } from "../features/integrations/queries.js";

const EMPTY_LIST = {
  rows: [],
  nextOffset: null,
  investigationTotal: 0,
};

// The pages a signed-in load lands on, answered empty.
function pages({ path }: ApiRequest): Response | undefined {
  const organization = organizationAnswer(path);
  if (organization !== undefined) return organization;
  if (path.startsWith("/api/sessions")) return json(EMPTY_LIST);
  if (path.startsWith("/api/runners")) return json([]);
  if (path.startsWith("/api/integrations/")) {
    return json({ configured: false, lastReceivedAt: null });
  }
  return undefined;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// Signed out answers get-session with null, as Better Auth does.
function signedOut(setupRequired: boolean) {
  return stubApi((request) => {
    if (request.path === GET_SESSION_PATH) return json(null);
    if (request.path === "/api/setup") return json({ required: setupRequired });
    return undefined;
  });
}

describe("the session check", () => {
  it("opens the app on the investigations page when signed in, asking nothing of setup", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const { requests } = stubApi((request) =>
      request.path === GET_SESSION_PATH ? json(sessionBody()) : pages(request),
    );
    const { router } = renderApp({ path: "/" });

    expect(
      await screen.findByRole("link", { name: /integrations/i }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/investigations");
    expect(requests(GET_SESSION_PATH)).toHaveLength(1);
    expect(requests("/api/setup")).toHaveLength(0);
  });

  it("sends a fresh install to account setup, from the app or the login page", async () => {
    signedOut(true);
    const { router } = renderApp({ path: "/" });

    expect(await screen.findByText(/create your account/i)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/setup");

    await act(() => router.navigate({ to: "/login" }));
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("sends a signed-out visit to the login form, and setup there once the owner exists", async () => {
    signedOut(false);
    const { router } = renderApp({ path: "/integrations" });

    expect(
      await screen.findByRole("heading", { name: /^log in$/i }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");

    await act(() => router.navigate({ to: "/setup" }));
    expect(router.state.location.pathname).toBe("/login");
  });

  it("signs out on a data route's 401 only once the session read says it is gone", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    // Flipped to model a session that dies between two identical failures.
    let authenticated = true;
    stubApi((request) => {
      if (request.path === GET_SESSION_PATH) {
        return json(authenticated ? sessionBody() : null);
      }
      if (request.path === "/api/setup") return json({ required: false });
      // A rejected integration credential: a real 401 from a data route.
      if (request.path === "/api/runners") {
        return json({ error: "bad credential" }, 401);
      }
      return pages(request);
    });
    const { router, queryClient } = renderApp({ path: "/integrations" });
    await screen.findByRole("link", { name: /integrations/i });

    await act(() =>
      queryClient.refetchQueries({ queryKey: runnersQuery().queryKey }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/integrations"),
    );

    authenticated = false;
    await act(() =>
      queryClient.refetchQueries({ queryKey: runnersQuery().queryKey }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(
      await screen.findByRole("heading", { name: /^log in$/i }),
    ).toBeInTheDocument();
  });
});
