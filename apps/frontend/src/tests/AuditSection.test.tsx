import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { AuditEvent } from "@nightwarden/shared";

import { renderApp } from "./renderWithProviders.js";
import { signedInAnswer } from "./auth-session.js";
import { json, stubApi } from "./stubApi.js";
import { MockEventSource } from "./mockEventSource.js";

const ACTOR = {
  id: 1,
  at: "2026-11-20T10:30:00.000Z",
  actorId: "u1",
  actorName: "Jordan Lee",
  actorEmail: "jordan@example.com",
  sessionId: null,
};

// One event of every action, and what a reader must find in its row.
const CASES: { event: AuditEvent; shows: string[] }[] = [
  {
    event: {
      ...ACTOR,
      action: "write_approved",
      target: "web-01/shop/api",
      details: { tool: "RestartDockerService", input: {} },
    },
    shows: ["RestartDockerService", "web-01/shop/api"],
  },
  {
    event: {
      ...ACTOR,
      action: "write_rejected",
      target: "web-01/shop/api",
      details: {
        tool: "RestartDockerService",
        input: {},
        reason: "wrong host",
      },
    },
    shows: ["RestartDockerService", "web-01/shop/api", "wrong host"],
  },
  {
    event: {
      ...ACTOR,
      action: "member_invited",
      target: "jane@example.com",
      details: { email: "jane@example.com", role: "viewer" },
    },
    shows: ["jane@example.com", "Viewer"],
  },
  {
    event: {
      ...ACTOR,
      action: "invitation_canceled",
      target: "jane@example.com",
      details: { email: "jane@example.com" },
    },
    shows: ["jane@example.com"],
  },
  {
    event: {
      ...ACTOR,
      action: "member_joined",
      target: "jane@example.com",
      details: { email: "jane@example.com", role: "member" },
    },
    shows: ["jane@example.com", "Member"],
  },
  {
    event: {
      ...ACTOR,
      action: "member_role_changed",
      target: "jane@example.com",
      details: {
        email: "jane@example.com",
        role: "admin",
        previousRole: "viewer",
      },
    },
    shows: ["jane@example.com", "Admin", "Viewer"],
  },
  {
    event: {
      ...ACTOR,
      action: "member_removed",
      target: "jane@example.com",
      details: { email: "jane@example.com", role: "member" },
    },
    shows: ["jane@example.com", "Member"],
  },
  {
    event: {
      ...ACTOR,
      action: "team_created",
      target: "t1",
      details: { name: "Platform" },
    },
    shows: ["Platform"],
  },
  {
    event: {
      ...ACTOR,
      action: "team_deleted",
      target: "t1",
      details: { name: "Platform" },
    },
    shows: ["Platform"],
  },
  {
    event: {
      ...ACTOR,
      action: "team_renamed",
      target: "t1",
      details: { name: "Reliability", previousName: "Platform" },
    },
    shows: ["Platform", "Reliability"],
  },
  {
    event: {
      ...ACTOR,
      action: "team_member_added",
      target: "jane@example.com",
      details: { email: "jane@example.com", team: "Platform" },
    },
    shows: ["jane@example.com", "Platform"],
  },
  {
    event: {
      ...ACTOR,
      action: "team_member_removed",
      target: "jane@example.com",
      details: { email: "jane@example.com", team: "Platform" },
    },
    shows: ["jane@example.com", "Platform"],
  },
  {
    event: {
      ...ACTOR,
      action: "member_added",
      target: "jane@example.com",
      details: { email: "jane@example.com", role: "admin" },
    },
    shows: ["jane@example.com", "Admin"],
  },
  {
    event: {
      ...ACTOR,
      action: "organization_created",
      target: null,
      details: { name: "Acme Ops" },
    },
    shows: ["Acme Ops"],
  },
  {
    event: {
      ...ACTOR,
      action: "organization_updated",
      target: null,
      details: { fields: ["name", "logo"] },
    },
    shows: ["name", "logo"],
  },
  {
    event: {
      ...ACTOR,
      action: "mfa_reset",
      target: "jane@example.com",
      details: { email: "jane@example.com" },
    },
    shows: ["jane@example.com"],
  },
];

function setup(pages: { events: AuditEvent[]; nextOffset: number | null }[]) {
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("innerWidth", 1280);
  const api = stubApi(({ path }) => {
    const signedIn = signedInAnswer(path);
    if (signedIn !== undefined) return signedIn;
    if (path.startsWith("/api/audit")) {
      const offset = Number(
        new URL(path, "http://x").searchParams.get("offset"),
      );
      return json(pages[offset === 0 ? 0 : 1]);
    }
    if (path.startsWith("/api/sessions")) {
      return json({ rows: [], nextOffset: null, investigationTotal: 0 });
    }
    return undefined;
  });
  renderApp({ path: "/settings/audit" });
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuditSection", () => {
  it.each(CASES)(
    "draws $event.action from its details",
    async ({ event, shows }) => {
      setup([{ events: [event], nextOffset: null }]);

      const row = (await screen.findByText("Jordan Lee")).closest(
        '[role="listitem"]',
      );
      for (const text of shows) expect(row).toHaveTextContent(text);
    },
  );

  it("asks for the next page from the offset the last one named", async () => {
    const [first, second] = CASES;
    if (first === undefined || second === undefined)
      throw new Error("no cases");
    const api = setup([
      { events: [{ ...first.event, id: 2 }], nextOffset: 50 },
      { events: [{ ...second.event, id: 1 }], nextOffset: null },
    ]);

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: /load more/i }));

    await waitFor(() =>
      expect(api.requests("/api/audit").map((r) => r.path)).toEqual([
        "/api/audit?offset=0",
        "/api/audit?offset=50",
      ]),
    );
  });
});
