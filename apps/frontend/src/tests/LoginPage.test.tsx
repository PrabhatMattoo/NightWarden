import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

import { stubSigningIn } from "./auth-session.js";
import { renderApp } from "./renderWithProviders.js";
import { json } from "./stubApi.js";
import type { ApiRequest } from "./stubApi.js";

const SIGN_IN_PATH = "/api/auth/sign-in/email";

function setup(answer?: (request: ApiRequest) => Response | undefined) {
  const api = stubSigningIn({
    setupRequired: false,
    credentialPath: SIGN_IN_PATH,
    credentialAnswer: () => json({ token: "t", user: {} }),
    ...(answer !== undefined && { answer }),
  });
  const { router } = renderApp({ path: "/login" });
  return { ...api, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const VERIFY_TOTP_PATH = "/api/auth/two-factor/verify-totp";
const VERIFY_BACKUP_CODE_PATH = "/api/auth/two-factor/verify-backup-code";

// A password that Better Auth answers with the second step instead of a session.
async function reachCodeStep(path = "/login") {
  const user = userEvent.setup();
  const api = stubSigningIn({
    setupRequired: false,
    credentialPath: SIGN_IN_PATH,
    credentialAnswer: () =>
      json({ twoFactorRedirect: true, twoFactorMethods: ["totp"] }),
    answer: (request) =>
      request.path === VERIFY_TOTP_PATH ||
      request.path === VERIFY_BACKUP_CODE_PATH
        ? json({ token: "t", user: {} })
        : undefined,
  });
  const { router } = renderApp({ path });
  await screen.findByRole("heading", { name: /^log in$/i });
  await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
  await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
  await user.click(screen.getByRole("button", { name: /^log in$/i }));
  await screen.findByRole("heading", { name: /multi-factor/i });
  return { user, router, ...api };
}

describe("LoginPage", () => {
  // An invitation sends an existing account here and expects it back once the code is in.
  it.each([
    ["keeps a path inside the app", "/invite/inv1", "/invite/inv1"],
    ["drops one that leaves the app", "//evil.example", "/investigations"],
  ])(
    "enters the redirect after the code step, and %s",
    async (_case, redirect, landing) => {
      const { user, router } = await reachCodeStep(
        `/login?redirect=${encodeURIComponent(redirect)}`,
      );

      await user.type(screen.getByLabelText("Authentication code"), "123456");

      await waitFor(() => expect(router.state.location.pathname).toBe(landing));
    },
  );

  it("sends the six digits to the authenticator endpoint and enters the app", async () => {
    const { user, router, requests } = await reachCodeStep();

    await user.type(screen.getByLabelText("Authentication code"), "123456");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/investigations"),
    );
    expect(requests(VERIFY_TOTP_PATH)).toMatchObject([
      { method: "POST", body: { code: "123456" } },
    ]);
    expect(requests(VERIFY_BACKUP_CODE_PATH)).toHaveLength(0);
  });

  it("sends a recovery code to the recovery endpoint instead", async () => {
    const { user, router, requests } = await reachCodeStep();

    await user.click(
      screen.getByRole("button", { name: /use a recovery code/i }),
    );
    await user.type(screen.getByLabelText("Recovery code"), "abcde-12345");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/investigations"),
    );
    expect(requests(VERIFY_BACKUP_CODE_PATH)).toMatchObject([
      { method: "POST", body: { code: "abcde-12345" } },
    ]);
    expect(requests(VERIFY_TOTP_PATH)).toHaveLength(0);
  });

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
