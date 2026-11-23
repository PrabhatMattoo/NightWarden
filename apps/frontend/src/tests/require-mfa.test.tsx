import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

import { renderApp } from "./renderWithProviders.js";
import {
  ORGANIZATION_PATH,
  organizationBody,
  signedInAnswer,
} from "./auth-session.js";
import { MockEventSource } from "./mockEventSource.js";
import { json, stubApi } from "./stubApi.js";

const ENABLE_PATH = "/api/auth/two-factor/enable";
const VERIFY_PATH = "/api/auth/two-factor/verify-totp";

// An admin with no MFA of their own, on General.
function setup() {
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("EventSource", MockEventSource);
  const api = stubApi(({ path, method }) => {
    if (path === ORGANIZATION_PATH && method === "PATCH") {
      return json(organizationBody({ requireMfa: true }));
    }
    const signedIn = signedInAnswer(path);
    if (signedIn !== undefined) return signedIn;
    if (path === ENABLE_PATH) {
      return json({
        totpURI:
          "otpauth://totp/Acme:admin?secret=JBSWY3DPEHPK3PXP&issuer=Acme",
        backupCodes: ["aaaaa-bbbbb"],
      });
    }
    if (path === VERIFY_PATH) return json({ token: "t", user: {} });
    return undefined;
  });
  const { router } = renderApp({ path: "/settings/general" });
  return { ...api, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requiring MFA", () => {
  it("sends an admin without MFA to set up their own first, and turns the requirement on only as that finishes", async () => {
    const { router, requests } = setup();
    const user = userEvent.setup();
    const patches = () =>
      requests(ORGANIZATION_PATH).filter((r) => r.method === "PATCH");

    await user.click(
      await screen.findByRole("switch", { name: "Require MFA" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Set up MFA",
      }),
    );
    await waitFor(() =>
      expect(router.state.location.href).toBe("/mfa/setup?after=require-mfa"),
    );
    expect(patches()).toHaveLength(0);

    await user.type(await screen.findByLabelText("Password"), "a-password");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(
      await screen.findByLabelText("Authentication code"),
      "123456",
    );
    await user.click(
      await screen.findByRole("button", { name: "I have saved them" }),
    );

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/general"),
    );
    expect(patches().map((r) => r.body)).toEqual([{ requireMfa: true }]);
  });
});
