import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { OrganizationMember } from "@nightwarden/shared";

import { renderApp } from "./renderWithProviders.js";
import { signedInAnswer } from "./auth-session.js";
import { json, stubApi } from "./stubApi.js";
import { MockEventSource } from "./mockEventSource.js";

function member(
  id: string,
  name: string,
  role: OrganizationMember["role"],
  mfaEnabled = false,
): OrganizationMember {
  return {
    id,
    userId: `u-${id}`,
    mfaEnabled,
    name,
    email: `${name.toLowerCase()}@example.com`,
    image: null,
    role,
    joinedAt: "2026-11-01T00:00:00.000Z",
    teams: [],
  };
}

const MAIL_UNSET = {
  host: null,
  port: null,
  security: null,
  username: null,
  passwordSet: false,
  from: null,
  locked: {},
};

const MAIL_SET = {
  ...MAIL_UNSET,
  host: "smtp.example.com",
  port: 587,
  from: "nightwarden@example.com",
};

const DEFAULT_TEAM = {
  id: "t1",
  name: "Acme",
  isDefault: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  memberCount: 1,
};

// An admin's Members page over the real route tree, answering what the API would.
function setup(
  answer: (request: { path: string; method: string }) => Response | undefined,
) {
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("innerWidth", 1280);
  const api = stubApi((request) => {
    const custom = answer(request);
    if (custom !== undefined) return custom;
    const { path, method } = request;
    const signedIn = signedInAnswer(path);
    if (signedIn !== undefined) return signedIn;
    if (path === "/api/organization/members") {
      return json([
        member("m1", "Ada", "admin"),
        member("m2", "Grace", "member", true),
      ]);
    }
    if (path === "/api/organization/invitations" && method === "GET") {
      return json([]);
    }
    if (path === "/api/organization/teams") return json([DEFAULT_TEAM]);
    if (path === "/api/config/mail") return json(MAIL_UNSET);
    if (path.startsWith("/api/sessions")) {
      return json({ rows: [], nextOffset: null, investigationTotal: 0 });
    }
    return undefined;
  });
  renderApp({ path: "/settings/members" });
  return api;
}

async function pickRole(name: string, role: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: role }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MembersSection", () => {
  it("sends the chosen role for that member", async () => {
    const api = setup(({ path, method }) =>
      path === "/api/organization/members/m2" && method === "PATCH"
        ? new Response(null, { status: 204 })
        : undefined,
    );

    await pickRole("Role of Grace", "Viewer");

    await waitFor(() =>
      expect(
        api.requests("/api/organization/members/m2").map((r) => r.body),
      ).toEqual([{ role: "viewer" }]),
    );
  });

  it("sends the invitation as typed once mail is set up", async () => {
    const api = setup(({ path, method }) => {
      if (path === "/api/config/mail") return json(MAIL_SET);
      return path === "/api/organization/invitations" && method === "POST"
        ? new Response(null, { status: 204 })
        : undefined;
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /invite/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Email"), "jane@example.com");
    await user.click(screen.getByRole("combobox", { name: "Role" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));
    await user.click(screen.getByRole("button", { name: /send invitation/i }));

    await waitFor(() =>
      expect(
        api
          .requests("/api/organization/invitations")
          .filter((r) => r.method === "POST")
          .map((r) => r.body),
      ).toEqual([
        // The default team is ticked from the start.
        { email: "jane@example.com", role: "viewer", teamIds: ["t1"] },
      ]),
    );
  });

  it("sends the MFA reset and the removal for that member once each is confirmed", async () => {
    const api = setup(({ path, method }) =>
      (path === "/api/organization/members/m2/reset-mfa" &&
        method === "POST") ||
      (path === "/api/organization/members/m2" && method === "DELETE")
        ? new Response(null, { status: 204 })
        : undefined,
    );
    const user = userEvent.setup();
    const actOnGrace = async (item: string, confirm: string) => {
      await user.click(
        await screen.findByRole("button", { name: "Actions for Grace" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: item }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: confirm,
        }),
      );
    };

    await actOnGrace("Reset MFA", "Reset MFA");
    await waitFor(() =>
      expect(
        api.requests("/api/organization/members/m2/reset-mfa"),
      ).toHaveLength(1),
    );
    await actOnGrace("Remove", "Remove");
    await waitFor(() =>
      expect(
        api
          .requests("/api/organization/members/m2")
          .filter((r) => r.method === "DELETE"),
      ).toHaveLength(1),
    );
  });
});
