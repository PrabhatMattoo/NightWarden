import { act, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

import { renderApp } from "./renderWithProviders.js";
import { json, stubApi } from "./stubApi.js";
import type { ApiRequest } from "./stubApi.js";
import { MockEventSource } from "./mockEventSource.js";

const SIGNED_IN = {
  ownerExists: true,
  authenticated: true,
  email: "a@b.com",
  name: "Admin",
  theme: "system",
};

const EMPTY_LIST = {
  rows: [],
  nextOffset: null,
  investigationTotal: 0,
  queue: { waiting: 0, running: 0, limit: 10, oldestArrivedAt: null },
};

// The pages a signed-in load lands on, answered empty.
function pages({ path }: ApiRequest): Response | undefined {
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

describe("the session check", () => {
  it("opens the app on the investigations page when signed in", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    stubApi((request) =>
      request.path === "/api/auth-status" ? json(SIGNED_IN) : pages(request),
    );
    const { router } = renderApp({ path: "/" });

    expect(
      await screen.findByRole("link", { name: /integrations/i }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/investigations");
  });

  it("sends a fresh install to account setup", async () => {
    stubApi((request) =>
      request.path === "/api/auth-status"
        ? json({ ownerExists: false })
        : undefined,
    );
    const { router } = renderApp({ path: "/" });

    expect(await screen.findByText(/create your account/i)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sends a signed-out visit to the login form", async () => {
    stubApi((request) =>
      request.path === "/api/auth-status"
        ? json({ ownerExists: true, authenticated: false })
        : undefined,
    );
    const { router } = renderApp({ path: "/integrations" });

    expect(
      await screen.findByRole("heading", { name: /^log in$/i }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  // Nothing for the first second, so a fast check never flashes a loader.
  it("shows the loading indicator only once the check outlasts a second", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderApp({ path: "/" });

    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText(/log in/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /integrations/i }),
    ).not.toBeInTheDocument();
  });

  it("signs out on a data route's 401 only once the status says the session is gone", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    // Flipped to model a session that dies between two identical failures.
    let authenticated = true;
    stubApi((request) => {
      if (request.path === "/api/auth-status") {
        return json(
          authenticated
            ? SIGNED_IN
            : { ownerExists: true, authenticated: false },
        );
      }
      // A rejected integration credential: a real 401 from a data route.
      if (request.path === "/api/runners") {
        return json({ error: "bad credential" }, 401);
      }
      return pages(request);
    });
    const { router, queryClient } = renderApp({ path: "/integrations" });
    await screen.findByRole("link", { name: /integrations/i });

    await act(() => queryClient.refetchQueries({ queryKey: ["runners"] }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/integrations"),
    );

    authenticated = false;
    await act(() => queryClient.refetchQueries({ queryKey: ["runners"] }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(
      await screen.findByRole("heading", { name: /^log in$/i }),
    ).toBeInTheDocument();
  });
});
