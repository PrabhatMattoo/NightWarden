import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

import { stubSigningIn } from "./auth-session.js";
import { renderApp } from "./renderWithProviders.js";
import { json } from "./stubApi.js";
import type { ApiRequest } from "./stubApi.js";

function setup(
  path: string,
  answer?: (request: ApiRequest) => Response | undefined,
) {
  const api = stubSigningIn({
    setupRequired: true,
    credentialPath: "/api/setup",
    credentialAnswer: () => new Response(null, { status: 204 }),
    ...(answer !== undefined && { answer }),
  });
  const { router } = renderApp({ path });
  return { ...api, router };
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^organization name/i), "Acme Ops");
  await user.type(screen.getByLabelText(/^name/i), "Admin");
  await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
  await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
  await user.click(screen.getByRole("button", { name: /create account/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SetupPage", () => {
  it("posts the token from the link with the account, asks for no token, and enters the app", async () => {
    const user = userEvent.setup();
    const { requests, router } = setup("/setup#token=abc-123_x");
    await screen.findByText(/create your account/i);

    expect(screen.queryByLabelText(/setup token/i)).not.toBeInTheDocument();

    await fillAndSubmit(user);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/investigations"),
    );
    expect(
      requests("/api/setup").filter((request) => request.method === "POST"),
    ).toMatchObject([
      {
        body: {
          token: "abc-123_x",
          organizationName: "Acme Ops",
          name: "Admin",
          email: "admin@example.com",
          password: "correcthorsebattery",
        },
      },
    ]);
  });

  it("asks for the token only when the link carries none, and posts what was typed", async () => {
    const user = userEvent.setup();
    const { requests } = setup("/setup");

    await user.type(await screen.findByLabelText(/setup token/i), "typed-one");
    await fillAndSubmit(user);

    await waitFor(() =>
      expect(
        requests("/api/setup").filter((request) => request.method === "POST"),
      ).toMatchObject([{ body: { token: "typed-one" } }]),
    );
  });

  it("shows the server's refusal inline and stays on the page", async () => {
    const user = userEvent.setup();
    const { router } = setup("/setup#token=wrong", (request) =>
      request.path === "/api/setup" && request.method === "POST"
        ? json({ error: "The setup token is not valid." }, 403)
        : undefined,
    );
    await screen.findByText(/create your account/i);

    await fillAndSubmit(user);

    expect(
      await screen.findByText(/setup token is not valid/i),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/setup");
  });

  // With nothing wrong there is no live region in the tree at all, and an
  // error binds to the field that caused it.
  it("mounts no error region until there is an error, then binds it to its field", async () => {
    const user = userEvent.setup();
    setup("/setup#token=abc");
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
});
