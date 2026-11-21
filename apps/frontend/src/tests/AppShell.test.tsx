import { screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

import type { SessionAlert, SessionListRow } from "@nightwarden/shared";

import { renderApp } from "./renderWithProviders.js";
import { GET_SESSION_PATH, sessionBody } from "./auth-session.js";
import { json, stubApi } from "./stubApi.js";
import { MockEventSource } from "./mockEventSource.js";

const OWNER_EMAIL = "admin@example.com";

const SESSION_1: SessionListRow = {
  sessionId: "s1",
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  investigation: false,
  severityLabel: null,
  status: null,
  statusLine: null,
  awaitingHumanInput: false,
};

function investigationRow(
  sessionId: string,
  title: string,
  overrides: Partial<SessionListRow> = {},
): SessionListRow {
  return {
    ...SESSION_1,
    sessionId,
    title,
    createdAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
    lastActivityAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
    investigation: true,
    ...overrides,
  };
}

// Two in one group so severity has something to order, a status per group so
// the triage order is visible, and one row carrying no severity at all.
const INVESTIGATIONS = [
  // Listed first, and ordered second: "P1" is a word we cannot rank.
  investigationRow("inv-p1", "Checkout latency spike", {
    severityLabel: "P1",
    status: "action_required",
    statusLine: "Waiting on an answer",
  }),
  // Opened fourteen minutes ago, moved two: the row reads the second.
  investigationRow("inv-crit", "Container memory high", {
    lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    severityLabel: "critical",
    status: "action_required",
    statusLine: "Waiting on approval",
  }),
  investigationRow("inv-run", "Redis pool exhausted", {
    severityLabel: "warning",
    status: "running",
    statusLine: "Connection pool starved by the checkout deploy",
  }),
  investigationRow("inv-done", "Disk filling on db-02", {
    status: "resolved",
    statusLine: "Alert condition recovered",
  }),
  // Nothing is holding this one up, so its recommendation reads under Completed
  // rather than competing with the runs that are actually frozen.
  investigationRow("inv-fixed", "Worker OOM on ingest", {
    status: "completed",
    statusLine: "Raise the pod memory limit",
  }),
  // Held by the hourly limit, so it waits for a person to start it.
  investigationRow("inv-held", "Queue depth high on ingest", {
    status: "not_started",
    statusLine:
      "10 investigations started on their own in the past hour, the most Settings → Limits allows.",
  }),
];

function alertOn(alertType: string, clearedAt: string | null): SessionAlert {
  return {
    alert: {
      sourceAlertId: `${alertType}-1`,
      labels: { alertname: alertType },
      annotations: {},
      alertType,
      firedAt: "2026-08-19T02:14:00.000Z",
      generatorURL: null,
      values: {},
    },
    arrivedAt: "2026-08-19T02:14:00.000Z",
    clearedAt,
    injected: false,
    droppedAlerts: 0,
    groupContext: null,
  };
}

// The real route tree, not a copy of it: the redirect, the two session route
// families and the pages they land on are exactly what ships.
function setup({ path = "/agent" }: { path?: string } = {}) {
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("innerWidth", 1280);

  // What the session says it is. This is what the layout keys on.
  let investigation = false;
  const setInvestigation = (value: boolean): void => {
    investigation = value;
  };

  // What a record's own fetch answers, so a case can change it under an open
  // page the way the recovery sweep does.
  let alerts: SessionAlert[] = [];
  const setAlerts = (next: SessionAlert[]): void => {
    alerts = next;
  };

  const api = stubApi(({ path: url }) => {
    if (url === "/api/auth/sign-out") return json({ success: true });
    if (url === GET_SESSION_PATH) {
      return json(sessionBody({ email: OWNER_EMAIL }));
    }
    if (url === "/api/chat") return json({ sessionId: "new-s1" }, 202);
    if (url.startsWith("/api/runners")) return json([]);
    // Configured, so the page has a status line to put in its controls row.
    if (url.startsWith("/api/integrations/alerting/alertmanager")) {
      return json({
        configured: true,
        ingestUrl: "http://localhost:3000/api/alerts/ingest",
        lastReceivedAt: new Date().toISOString(),
      });
    }
    if (url.startsWith("/api/integrations/")) {
      return json({ configured: false, lastReceivedAt: null });
    }
    if (url.endsWith("/report")) {
      return json({ error: "no report for session" }, 404);
    }
    const record = /\/sessions\/([^?/]+)$/.exec(url);
    if (record !== null) {
      const id = record[1]!;
      const known = INVESTIGATIONS.find((row) => row.sessionId === id);
      return json({
        sessionId: id,
        title: known?.title ?? "Check disk",
        createdAt: "2026-06-13T00:00:00.000Z",
        investigation: known !== undefined || investigation,
        running: false,
        alerts,
        transcript: [],
      });
    }
    if (url.startsWith("/api/sessions")) {
      // Filtered the way the server filters: closed gathers the three endings.
      const query = new URL(url, "http://test").searchParams;
      const status = query.get("status");
      const gathers = (filter: string, row: SessionListRow): boolean =>
        (filter === "active"
          ? ["action_required", "running"]
          : filter === "closed"
            ? ["completed", "stopped", "failed"]
            : [filter]
        ).includes(row.status ?? "");
      const rows =
        query.get("kind") === "investigation"
          ? INVESTIGATIONS.filter(
              (row) => status === null || gathers(status, row),
            )
          : [SESSION_1];
      return json({
        rows,
        nextOffset: null,
        investigationTotal: INVESTIGATIONS.length,
      });
    }
    return json({});
  });

  const { router, queryClient: qc } = renderApp({ path });

  return { router, qc, api, setInvestigation, setAlerts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function precedes(a: HTMLElement, b: HTMLElement): boolean {
  return (
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

describe("Shell", () => {
  describe("signing out", () => {
    it("asks first, then leaves for the login page once the server has ended the session", async () => {
      const user = userEvent.setup();
      const { router, api } = setup({ path: "/investigations" });
      await screen.findByRole("heading", { name: "Investigations" });

      await user.click(screen.getByRole("button", { name: "Account menu" }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Sign out" }),
      );
      const confirm = await screen.findByRole("alertdialog");
      expect(api.requests("/api/auth/sign-out").length > 0).toBe(false);
      await user.click(
        within(confirm).getByRole("button", { name: "Sign out" }),
      );

      expect(
        await screen.findByRole("heading", { name: /^log in$/i }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/login");
      expect(api.requests("/api/auth/sign-out").length > 0).toBe(true);
    });
  });

  describe("routes", () => {
    it("opens on Investigations rather than a chat greeting", async () => {
      const { router } = setup({ path: "/" });

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations");
      });
      expect(
        await screen.findByRole("heading", { name: "Investigations" }),
      ).toBeInTheDocument();
    });
  });

  describe("the persistent chat", () => {
    it("submitting from /agent navigates to /agent/:id without a remount", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      const textarea = await screen.findByRole("textbox");
      // The message box renders before the stream opens, so waiting on the textarea
      // and reading the stream is a gap that only closes on an idle machine.
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());
      const streamBefore = MockEventSource.latest;

      await user.type(textarea, "Check disk usage on prod");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/agent/new-s1");
      });
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    // The layout is the route's alone, so a session becoming an investigation
    // replaces the address rather than rearranging the page mid-read.
    it("morphs on the address, not on the session's own flag", async () => {
      const user = userEvent.setup();
      const { router, setInvestigation, api } = setup();

      await screen.findByRole("textbox");
      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/agent/new-s1");
      });
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());
      const streamBefore = MockEventSource.latest;

      const sessionFetches = (): number =>
        api
          .requests("/api/sessions/new-s1")
          .filter((r) => r.path === "/api/sessions/new-s1").length;
      const before = sessionFetches();

      setInvestigation(true);
      act(() => {
        MockEventSource.broadcast({
          messageId: "m-1",
          type: "MESSAGE",
          payload: {
            sessionId: "new-s1",
            message: {
              kind: "assistant",
              content: "Opening an investigation.",
            },
          },
        });
      });
      // The flag has demonstrably reached the client, and moved nothing.
      await waitFor(() => expect(sessionFetches()).toBeGreaterThan(before));
      expect(
        screen.queryByRole("button", { name: /show the report/i }),
      ).not.toBeInTheDocument();

      await act(async () => {
        await router.navigate({
          to: "/investigations/$id",
          params: { id: "new-s1" },
          replace: true,
        });
      });

      // The workspace mounts on the address; the report opens on request and,
      // with nothing recorded, says so rather than rendering blank.
      await user.click(
        await screen.findByRole("button", { name: /show the report/i }),
      );
      expect(
        await screen.findByRole("complementary", {
          name: /investigation report/i,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/has not recorded a finding yet/i),
      ).toBeInTheDocument();
      expect(MockEventSource.latest).toBe(streamBefore);
    });
  });

  describe("the report panel", () => {
    // The toggle is a sibling of the panel, so closing the panel cannot take
    // the control that reopens it with it.
    it("closes and reopens without interrupting the live stream", async () => {
      const user = userEvent.setup();
      const { setInvestigation } = setup({ path: "/investigations/new-s1" });

      setInvestigation(true);
      // With nothing recorded the panel starts closed; open it to read.
      await user.click(
        await screen.findByRole("button", { name: /show the report/i }),
      );
      expect(
        await screen.findByRole("complementary", {
          name: /investigation report/i,
        }),
      ).toBeInTheDocument();
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());
      const streamBefore = MockEventSource.latest;

      await user.click(
        screen.getByRole("button", { name: /hide the report/i }),
      );

      await waitFor(() => {
        expect(
          screen.queryByRole("complementary", {
            name: /investigation report/i,
          }),
        ).not.toBeInTheDocument();
      });
      await user.click(
        screen.getByRole("button", { name: /show the report/i }),
      );

      await waitFor(() => {
        expect(
          screen.getByRole("complementary", { name: /investigation report/i }),
        ).toBeInTheDocument();
      });
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("maximizes to the full stage without unmounting the chat", async () => {
      const user = userEvent.setup();
      const { setInvestigation } = setup({ path: "/investigations/new-s1" });

      setInvestigation(true);
      await user.click(
        await screen.findByRole("button", { name: /show the report/i }),
      );
      await screen.findByRole("complementary", {
        name: /investigation report/i,
      });
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());
      const streamBefore = MockEventSource.latest;

      await user.click(
        screen.getByRole("button", { name: /maximize the report/i }),
      );

      // The report owns the stage; the chat is hidden but still mounted, so the
      // stream survives it and no refetch is owed.
      expect(
        screen.getByText(/has not recorded a finding yet/i),
      ).toBeInTheDocument();
      // Nothing to drag while it owns the stage, so the handle steps aside.
      expect(
        screen.queryByRole("separator", { name: /resize the report/i }),
      ).not.toBeInTheDocument();
      expect(MockEventSource.latest).toBe(streamBefore);

      await user.click(
        screen.getByRole("button", { name: /restore the report/i }),
      );
      expect(
        await screen.findByRole("separator", { name: /resize the report/i }),
      ).toBeInTheDocument();
      expect(MockEventSource.latest).toBe(streamBefore);
    });
  });

  describe("the investigations list", () => {
    it("groups by status in triage order, and renders no empty group", async () => {
      setup({ path: "/investigations" });

      const action = await screen.findByRole("region", {
        name: "Action required",
      });
      const held = screen.getByRole("region", { name: "Not started" });
      const investigating = screen.getByRole("region", {
        name: "Investigating",
      });
      const resolved = screen.getByRole("region", { name: "Resolved" });
      const completed = screen.getByRole("region", { name: "Completed" });

      // The header states the status and nothing else; the rows under it are
      // the count, and repeating it as a number adds no reading.
      expect(action).toHaveTextContent("Action required");
      expect(action).not.toHaveTextContent(/Action required\s*\d/);
      expect(within(action).getAllByRole("link")).toHaveLength(2);
      expect(within(investigating).getAllByRole("link")).toHaveLength(1);
      expect(within(resolved).getAllByRole("link")).toHaveLength(1);
      expect(within(completed).getAllByRole("link")).toHaveLength(1);
      expect(precedes(action, held)).toBe(true);
      expect(precedes(held, investigating)).toBe(true);
      expect(precedes(investigating, resolved)).toBe(true);
      // A finished run with a recommendation sorts below a recovered one and
      // out of the group meaning "somebody is being asked something".
      expect(precedes(resolved, completed)).toBe(true);

      // Nothing is Failed, so no Failed header is drawn.
      expect(
        screen.queryByRole("region", { name: "Failed" }),
      ).not.toBeInTheDocument();
    });

    /* On a run parked for an answer, when it last moved and when it opened are
       different numbers, and only the first one is worth reading. */
    it("ages a row from when it last moved, not from when it opened", async () => {
      setup({ path: "/investigations" });

      const row = await screen.findByRole("link", {
        name: /Container memory high/,
      });
      expect(row).toHaveTextContent("2m");
      expect(row).not.toHaveTextContent("14m");
    });

    /* Nothing reorders within a group. Ranking the sender's own word would put
       a fleet writing P1 last for using a word we do not recognise. */
    it("keeps the order the API sent, whatever the severity words are", async () => {
      setup({ path: "/investigations" });

      const first = await screen.findByRole("link", {
        name: /Checkout latency spike/,
      });
      const second = screen.getByRole("link", {
        name: /Container memory high/,
      });
      expect(precedes(first, second)).toBe(true);
    });

    // Active gathers what is still in play, so one view holds both a waiting run and a working one.
    it("switches views on the server, Active gathering what is still in play", async () => {
      const user = userEvent.setup();
      const { api } = setup({ path: "/investigations" });

      const all = await screen.findByRole("button", { name: "All" });
      expect(all).toHaveAttribute("aria-pressed", "true");
      for (const name of ["Active", "Resolved", "Closed"]) {
        expect(screen.getByRole("button", { name })).toBeInTheDocument();
      }

      const active = screen.getByRole("button", { name: "Active" });
      await user.click(active);
      await waitFor(() => {
        expect(
          screen.queryByRole("link", { name: /db-02/ }),
        ).not.toBeInTheDocument();
        expect(
          screen.getByRole("link", { name: /Container memory high/ }),
        ).toBeInTheDocument();
      });
      expect(
        api
          .requests("/api/sessions?")
          .some((r) => r.path.includes("status=active")),
      ).toBe(true);
      // One view's rows are one list, so the status headings step aside.
      expect(
        screen.queryByRole("region", { name: "Action required" }),
      ).not.toBeInTheDocument();

      // Pressing the chosen view again keeps it chosen.
      await user.click(active);
      expect(active).toHaveAttribute("aria-pressed", "true");
    });

    it("starts a held investigation from its row", async () => {
      const user = userEvent.setup();
      const { api } = setup({ path: "/investigations" });

      const held = await screen.findByRole("region", { name: "Not started" });
      expect(held).toHaveTextContent("Settings → Limits");
      await user.click(within(held).getByRole("button", { name: "Start" }));

      await waitFor(() =>
        expect(
          api
            .requests("/api/sessions/inv-held/start")
            .some((r) => r.method === "POST"),
        ).toBe(true),
      );
    });

    it("opens a row at its own record", async () => {
      const user = userEvent.setup();
      const { router } = setup({ path: "/investigations" });

      await user.click(
        await screen.findByRole("link", { name: /Container memory high/ }),
      );

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations/inv-crit");
      });
    });
  });

  describe("the investigation record", () => {
    it("carries its place in the queue and steps to the next record", async () => {
      const user = userEvent.setup();
      const { router } = setup({ path: "/investigations/inv-p1" });

      // First of four: the group's order is the order the API sent it in.
      expect(await screen.findByText("1 / 6")).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Next investigation" }),
      );

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations/inv-crit");
      });
      expect(await screen.findByText("2 / 6")).toBeInTheDocument();
      // Nothing navigated back to the list to get there.
      expect(
        screen.queryByRole("region", { name: "Action required" }),
      ).not.toBeInTheDocument();
    });

    /* The sweep clears the alert minutes after the run ended, so the record is
       already open when it happens. */
    it("shows a recovery discovered after the page was opened", async () => {
      const { setAlerts } = setup({ path: "/investigations/inv-done" });
      setAlerts([alertOn("HighMemoryUsage", null)]);

      await screen.findByText("HighMemoryUsage");
      expect(screen.queryByText("Recovered")).not.toBeInTheDocument();

      setAlerts([alertOn("HighMemoryUsage", "2026-08-19T02:31:00.000Z")]);
      act(() => {
        MockEventSource.broadcast({
          messageId: "m1",
          type: "REPORT_UPDATED",
          payload: { sessionId: "inv-done" },
        });
      });

      expect(await screen.findByText("Recovered")).toBeInTheDocument();
    });

    it("offers Copy report as Markdown and Delete, and never Mark as resolved", async () => {
      const user = userEvent.setup();
      setup({ path: "/investigations/inv-crit" });

      await user.click(
        await screen.findByRole("button", { name: "More actions" }),
      );

      expect(
        await screen.findByRole("menuitem", {
          name: "Copy report as Markdown",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: "Delete" }),
      ).toBeInTheDocument();
      // Status is derived and never declared; this is where a user would
      // most expect to declare it, so it must not be here.
      expect(
        screen.queryByRole("menuitem", { name: /mark as resolved/i }),
      ).not.toBeInTheDocument();
    });

    it("names the record in its delete confirmation and then deletes it", async () => {
      const user = userEvent.setup();
      const { router, api } = setup({ path: "/investigations/inv-crit" });

      await user.click(
        await screen.findByRole("button", { name: "More actions" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Container memory high");
      await user.click(within(dialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(
          api
            .requests("/api/sessions/inv-crit")
            .some((r) => r.method === "DELETE"),
        ).toBe(true);
      });
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations");
      });
    });
  });
});
