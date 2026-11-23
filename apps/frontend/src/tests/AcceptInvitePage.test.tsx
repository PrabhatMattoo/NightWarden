import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

import { renderApp } from "./renderWithProviders.js";
import { sessionBody, signedInAnswer } from "./auth-session.js";
import { MockEventSource } from "./mockEventSource.js";
import { json, stubApi } from "./stubApi.js";

const ACCEPT_PATH = "/api/invitations/inv1/accept";

const PREVIEW = {
  email: "jane@example.com",
  organizationName: "Acme",
  role: "member",
  inviterName: "Ada",
  accountExists: false,
  expired: false,
};

// The invitation link, opened by whoever `signedInAs` names, or by nobody.
function setup(
  preview: Partial<typeof PREVIEW>,
  signedInAs: string | null = null,
) {
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("EventSource", MockEventSource);
  let email = signedInAs;
  const api = stubApi(({ path, method }) => {
    if (path === "/api/invitations/inv1" && method === "GET") {
      return json({ ...PREVIEW, ...preview });
    }
    if (path === "/api/auth/sign-out") {
      email = null;
      return json({ success: true });
    }
    if (path === "/api/setup") return json({ required: false });
    const signedIn = signedInAnswer(
      path,
      email === null ? null : sessionBody({ email }),
    );
    if (signedIn !== undefined) return signedIn;
    if (path.startsWith("/api/sessions")) {
      return json({ rows: [], nextOffset: null, investigationTotal: 0 });
    }
    if (path === ACCEPT_PATH) return new Response(null, { status: 204 });
    return undefined;
  });
  const { router } = renderApp({ path: "/invite/inv1" });
  return { ...api, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AcceptInvitePage", () => {
  it("sends a name and password for a new account", async () => {
    const api = setup({ accountExists: false });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Name"), "Jane Doe");
    await user.type(
      screen.getByLabelText("Password"),
      "a-long-enough-password",
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(api.requests(ACCEPT_PATH).map((r) => r.body)).toEqual([
        { name: "Jane Doe", password: "a-long-enough-password" },
      ]),
    );
  });

  // Signing in, MFA included, is the sign-in page's; this page only joins.
  it("joins with the session alone for an existing account signed in as the invited address", async () => {
    const api = setup({ accountExists: true }, "jane@example.com");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Join Acme" }));

    await waitFor(() =>
      expect(api.requests(ACCEPT_PATH).map((r) => r.body)).toEqual([{}]),
    );
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("sends a signed-out existing account to sign in, and back to the invitation", async () => {
    setup({ accountExists: true });

    expect(
      await screen.findByRole("link", { name: "Sign in" }),
    ).toHaveAttribute("href", "/login?redirect=%2Finvite%2Finv1");
  });

  it("signs out someone else's session onto the sign-in page that returns to the invitation", async () => {
    const { router } = setup({ accountExists: true }, "bob@example.com");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(router.state.location.href).toBe(
        "/login?redirect=%2Finvite%2Finv1",
      ),
    );
  });
});
