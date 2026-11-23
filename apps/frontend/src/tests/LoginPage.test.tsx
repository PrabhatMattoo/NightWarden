import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

import { stubSigningIn } from "./auth-session.js";
import { renderApp } from "./renderWithProviders.js";
import { json } from "./stubApi.js";
import type { ApiRequest } from "./stubApi.js";

const SIGN_IN_PATH = "/api/auth/sign-in/email";

function setup(
  answer?: (request: ApiRequest) => Response | undefined,
  path = "/login",
) {
  const api = stubSigningIn({
    setupRequired: false,
    credentialPath: SIGN_IN_PATH,
    credentialAnswer: () => json({ token: "t", user: {} }),
    ...(answer !== undefined && { answer }),
  });
  const { router } = renderApp({ path });
  return { ...api, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LoginPage", () => {
  // An invitation sends an existing account here and expects it back once signed in.
  it.each([
    ["keeps a path inside the app", "/invite/inv1", "/invite/inv1"],
    ["drops one that leaves the app", "//evil.example", "/investigations"],
  ])(
    "enters the redirect once signed in, and %s",
    async (_case, redirect, landing) => {
      const user = userEvent.setup();
      const { router } = setup(
        undefined,
        `/login?redirect=${encodeURIComponent(redirect)}`,
      );
      await screen.findByRole("heading", { name: /^log in$/i });

      await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
      await user.type(
        screen.getByLabelText(/^password/i),
        "correcthorsebattery",
      );
      await user.click(screen.getByRole("button", { name: /^log in$/i }));

      await waitFor(() => expect(router.state.location.pathname).toBe(landing));
    },
  );

  it("submits the sign-in endpoint with email and password on valid login", async () => {
    const user = userEvent.setup();
    const { requests, router } = setup();
    await screen.findByRole("heading", { name: /^log in$/i });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/investigations"),
    );
    expect(requests(SIGN_IN_PATH)).toMatchObject([
      {
        method: "POST",
        body: { email: "admin@example.com", password: "correcthorsebattery" },
      },
    ]);
  });

  it("shows the server's error message inline when login fails", async () => {
    const user = userEvent.setup();
    const { router } = setup((request) =>
      // Better Auth answers a failure with `message`, which is what the page reads.
      request.path === SIGN_IN_PATH
        ? json({ message: "invalid credentials" }, 401)
        : undefined,
    );
    await screen.findByRole("heading", { name: /^log in$/i });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "wrongpassword123");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });
});
