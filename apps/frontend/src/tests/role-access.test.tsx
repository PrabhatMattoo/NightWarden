import { waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

import { renderApp } from "./renderWithProviders.js";
import { GET_SESSION_PATH, sessionBody } from "./auth-session.js";
import { json, stubApi } from "./stubApi.js";
import { MockEventSource } from "./mockEventSource.js";

// The real route tree, opened at `path` as someone holding `role`.
function openAs(role: string, path: string) {
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("innerWidth", 1280);
  stubApi(({ path: url }) => {
    if (url === GET_SESSION_PATH) return json(sessionBody({}, role));
    if (url.startsWith("/api/sessions")) {
      return json({ rows: [], nextOffset: null, investigationTotal: 0 });
    }
    return json({});
  });
  return renderApp({ path });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("where a role may go", () => {
  it.each(["member", "viewer"])(
    "lands a %s's direct visit to an Organization section on Profile",
    async (role) => {
      const { router } = openAs(role, "/settings/members");

      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/settings/profile"),
      );
    },
  );

  it("leads a viewer's visit to the chat or Integrations back to Investigations", async () => {
    const { router } = openAs("viewer", "/agent");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/investigations"),
    );

    await router.navigate({ to: "/integrations" });
    expect(router.state.location.pathname).toBe("/investigations");
  });
});
