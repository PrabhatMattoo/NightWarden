import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

import { renderApp } from "./renderWithProviders.js";
import { json, stubApi } from "./stubApi.js";
import type { ApiRequest } from "./stubApi.js";
import { MockEventSource } from "./mockEventSource.js";

const SIGNED_IN = {
  ownerExists: true,
  authenticated: true,
  email: "admin@example.com",
  name: "Admin",
  theme: "system",
};

/* Answers the status as `status` says until a sign-in or sign-up succeeds, then
   as signed in, the way the server would. */
function setup(
  status: object,
  answer?: (r: ApiRequest) => Response | undefined,
) {
  vi.stubGlobal("EventSource", MockEventSource);
  let signedIn = false;
  const api = stubApi((request) => {
    const custom = answer?.(request);
    if (custom !== undefined) return custom;
    if (request.path === "/api/auth-status") {
      return json(signedIn ? SIGNED_IN : status);
    }
    if (
      request.path === "/api/auth/sign-in/email" ||
      request.path === "/api/auth/sign-up/email"
    ) {
      signedIn = true;
      return json({ token: "t", user: { email: "admin@example.com" } });
    }
    if (request.path.startsWith("/api/sessions")) {
      return json({
        rows: [],
        nextOffset: null,
        investigationTotal: 0,
        queue: { waiting: 0, running: 0, limit: 10, oldestArrivedAt: null },
      });
    }
    return undefined;
  });
  const { router } = renderApp({ path: "/login" });
  return { ...api, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LoginPage", () => {
  it("submits the sign-up endpoint with email and password (not confirmPassword) on valid setup", async () => {
    const user = userEvent.setup();
    const { requests, router } = setup({ ownerExists: false });
    await screen.findByText(/create your account/i);

    await user.type(screen.getByLabelText(/your name/i), "Admin");
    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "correcthorsebattery",
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/investigations"),
    );
    expect(requests("/api/auth/sign-up/email")).toEqual([
      {
        path: "/api/auth/sign-up/email",
        method: "POST",
        body: {
          name: "Admin",
          email: "admin@example.com",
          password: "correcthorsebattery",
        },
      },
    ]);
  });

  it("submits the sign-in endpoint with email and password on valid login", async () => {
    const user = userEvent.setup();
    const { requests, router } = setup({
      ownerExists: true,
      authenticated: false,
    });
    await screen.findByRole("heading", { name: /^log in$/i });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/investigations"),
    );
    expect(requests("/api/auth/sign-in/email")).toEqual([
      {
        path: "/api/auth/sign-in/email",
        method: "POST",
        body: { email: "admin@example.com", password: "correcthorsebattery" },
      },
    ]);
  });

  // With nothing wrong there is no live region in the tree at all, and an
  // error binds to the field that caused it.
  it("mounts no error region until there is an error, then binds it to its field", async () => {
    const user = userEvent.setup();
    setup({ ownerExists: false });
    await screen.findByText(/create your account/i);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    const password = screen.getByLabelText(/^password/i);
    await user.type(password, "short");
    await user.tab();

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(/at least 12 characters/i);
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAttribute("aria-describedby", error.id);
  });

  it("shows the server's error message inline when login fails", async () => {
    const user = userEvent.setup();
    const { router } = setup(
      { ownerExists: true, authenticated: false },
      // Better Auth answers a failure with `message`, which is what the page reads.
      (request) =>
        request.path === "/api/auth/sign-in/email"
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
