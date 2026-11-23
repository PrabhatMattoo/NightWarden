import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { OrganizationMember, OrganizationTeam } from "@nightwarden/shared";

import { renderApp } from "./renderWithProviders.js";
import { signedInAnswer } from "./auth-session.js";
import { MockEventSource } from "./mockEventSource.js";
import { json, stubApi } from "./stubApi.js";

function team(
  id: string,
  name: string,
  isDefault: boolean,
  memberCount: number,
): OrganizationTeam {
  return {
    id,
    name,
    isDefault,
    createdAt: "2026-11-01T00:00:00.000Z",
    memberCount,
  };
}

function member(
  id: string,
  name: string,
  teams: { id: string; name: string }[],
): OrganizationMember {
  return {
    id,
    userId: `u-${id}`,
    name,
    email: `${name.toLowerCase()}@example.com`,
    image: null,
    role: "member",
    joinedAt: "2026-11-01T00:00:00.000Z",
    teams,
  };
}

const TEAMS = [team("t1", "Acme", true, 1), team("t2", "Platform", false, 1)];
const MEMBERS = [
  member("m1", "Ada", [{ id: "t1", name: "Acme" }]),
  member("m2", "Grace", [{ id: "t2", name: "Platform" }]),
];

// An admin on the Teams list, over the real route tree.
function setup() {
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("EventSource", MockEventSource);
  const api = stubApi(({ path, method }) => {
    const signedIn = signedInAnswer(path);
    if (signedIn !== undefined) return signedIn;
    if (path === "/api/organization/teams") return json(TEAMS);
    if (path === "/api/organization/members") return json(MEMBERS);
    if (path.startsWith("/api/organization/teams/") && method !== "GET") {
      return new Response(null, { status: 204 });
    }
    return undefined;
  });
  const { router } = renderApp({ path: "/settings/teams" });
  return { ...api, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a team's page", () => {
  it("opens from its row and sends who joins and leaves it", async () => {
    const { router, requests } = setup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("link", { name: "Platform" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/teams/t2"),
    );

    await user.click(
      await screen.findByRole("button", { name: "Remove Grace from Platform" }),
    );
    await user.click(screen.getByRole("combobox", { name: "Add a member" }));
    await user.click(await screen.findByRole("option", { name: "Ada" }));

    await waitFor(() =>
      expect(
        requests("/api/organization/teams/t2/members")
          .filter((r) => r.method === "POST")
          .map((r) => r.body),
      ).toEqual([{ userId: "u-m1" }]),
    );
    expect(
      requests("/api/organization/teams/t2/members/u-m2").map((r) => r.method),
    ).toEqual(["DELETE"]);
  });

  it("sends a team's deletion once confirmed", async () => {
    const { router, requests } = setup();
    const user = userEvent.setup();

    await router.navigate({
      to: "/settings/teams/$teamId",
      params: { teamId: "t2" },
    });
    await user.click(
      await screen.findByRole("button", { name: "Delete team" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );

    await waitFor(() =>
      expect(
        requests("/api/organization/teams/t2").map((r) => r.method),
      ).toEqual(["DELETE"]),
    );
  });
});
