import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderApp, TestProviders } from "./renderWithProviders.js";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";

import { SessionView } from "../features/session/SessionView.js";
import { FrontendEventsProvider } from "@/shared/events/FrontendEventsProvider";
import { MockEventSource } from "./mockEventSource.js";
import { sessionBody, signedIn, signedInAnswer } from "./auth-session";
import { json, stubApi } from "./stubApi";
import { sessionQuery } from "../features/session/queries.js";

// What the API accepts as a client message id.
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The projected transcript the API returns: items to draw, not raw messages.
const USER_TURN = {
  kind: "user_turn",
  id: "user-1-0",
  text: "Service is down on web-01",
};

type Api = ReturnType<typeof stubApi>;

// The network of the session most recently set up, so a case can read what it sent.
let sessionApi: Api | null = null;

// Every answer the view posted to the session's respond route, in order.
function respondedWith(): unknown[] {
  return (sessionApi?.requests("/api/sessions/s1/respond") ?? []).map(
    (r) => r.body,
  );
}

function setup(
  initialItems: object[] = [USER_TURN],
  running = false,
  role = "admin",
) {
  MockEventSource.reset();

  // Mutable, because the projection lives server-side now: a test that fires a
  // MESSAGE event states what the server would then project.
  let items = initialItems;
  const setItems = (next: object[]): void => {
    items = next;
  };

  // A decision the test can hold open, so "in flight" is a state it controls
  // rather than a race against an instantly-resolving mock.
  let holdingRespond = false;
  let releaseRespond: (() => void) | null = null;
  const holdRespond = (): (() => void) => {
    holdingRespond = true;
    return () => releaseRespond?.();
  };

  // A send that never reaches the API, which a case switches on mid-test.
  let messagesUnreachable = false;
  const cutMessages = (): void => {
    messagesUnreachable = true;
  };

  vi.stubGlobal("EventSource", MockEventSource);
  const api = stubApi(({ path }) => {
    if (path.endsWith("/messages") && messagesUnreachable) {
      return Promise.reject(new TypeError("network down"));
    }
    if (path.includes("/respond") && holdingRespond) {
      return new Promise<Response>((resolve) => {
        releaseRespond = () => resolve(json({}));
      });
    }
    // The session answers what it is and carries its transcript; the report is
    // a separate resource that may not exist yet.
    if (path === "/api/sessions/s1") {
      return json({
        sessionId: "s1",
        title: "Service is down on web-01",
        createdAt: "2026-06-13T00:00:00.000Z",
        lastActivityAt: "2026-06-13T00:00:00.000Z",
        investigation: false,
        running,
        reopenable: false,
        alerts: [],
        transcript: items,
      });
    }
    if (path.includes("/sessions/s1")) return json(items);
    return json({});
  });
  sessionApi = api;

  const qc = signedIn(
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    }),
    role,
  );

  // ChatInput uses useNavigate, so a router context is required.
  const root = createRootRoute({
    component: () => <SessionView sessionId="s1" />,
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <FrontendEventsProvider>
          <RouterProvider router={router} />
        </FrontendEventsProvider>
      </QueryClientProvider>
    </TestProviders>,
  );

  return { qc, api, setItems, holdRespond, cutMessages };
}

const AGO_MINUTES = (n: number): string =>
  new Date(Date.now() - n * 60_000).toISOString();

// One per group, so the day headings have something to hold, plus an
// investigation the chat list must never be asked for.
const CHAT_ROWS = [
  { sessionId: "c1", title: "Why is redis restarting?", minutes: 5 },
  { sessionId: "c2", title: "Explain the checkout deploy", minutes: 60 * 30 },
  {
    sessionId: "c3",
    title: "What does this label mean?",
    minutes: 60 * 24 * 9,
  },
];

// The header, its disclosure and its menu live in AgentPage, so this drives
// the real route tree the way AppShell does.
function setupPage({
  path = "/agent",
  running = false,
}: { path?: string; running?: boolean } = {}) {
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("innerWidth", 1280);

  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });

  const api = stubApi(({ path: url, method }) => {
    const signedIn = signedInAnswer(
      url,
      sessionBody({ email: "user@nightwarden.io", name: "User" }),
    );
    if (signedIn !== undefined) return signedIn;
    const record = /\/sessions\/([^?/]+)$/.exec(url);
    if (record !== null && !url.includes("?")) {
      const id = record[1]!;
      if (method === "DELETE") return new Response(null, { status: 204 });
      return json({
        sessionId: id,
        title: CHAT_ROWS.find((r) => r.sessionId === id)?.title ?? "Chat",
        createdAt: "2026-06-13T00:00:00.000Z",
        lastActivityAt: "2026-06-13T00:00:00.000Z",
        investigation: false,
        running,
        reopenable: false,
        alerts: [],
        transcript: [
          { kind: "user_turn", id: "u-1", text: "Why is redis restarting?" },
          {
            kind: "agent_text",
            id: "a-1",
            text: "It was OOM-killed at 02:14.",
          },
        ],
      });
    }
    if (url.startsWith("/api/sessions")) {
      // Answering only what was asked for is the point: a page that requested
      // every session would be handed the investigation below.
      const query = new URL(url, "http://test").searchParams;
      const q = query.get("q") ?? "";
      const rows =
        query.get("kind") === "chat"
          ? CHAT_ROWS.filter((row) =>
              row.title.toLowerCase().includes(q.toLowerCase()),
            ).map((row) => ({
              sessionId: row.sessionId,
              title: row.title,
              createdAt: AGO_MINUTES(row.minutes),
              lastActivityAt: AGO_MINUTES(row.minutes),
              investigation: false,
              severityLabel: null,
              status: null,
              statusLine: null,
              awaitingHumanInput: false,
            }))
          : [];
      return json({ rows, nextOffset: null, investigationTotal: 0 });
    }
    return json({});
  });

  const { router } = renderApp({ path });

  return { router, api, writeText };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SessionView", () => {
  describe("live streaming (TEXT_MESSAGE_CONTENT)", () => {
    it("accumulates delta text into a visible live buffer", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing...")).toBeInTheDocument();
      });
    });

    it("concatenates successive delta events into one buffer", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", delta: "Analyzing" },
        });
        MockEventSource.latest?.push({
          messageId: "m2",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", delta: " the logs..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing the logs...")).toBeInTheDocument();
      });
    });

    it("ignores session_delta for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "other-session",
            delta: "Other delta",
          },
        });
      });

      expect(screen.queryByText("Other delta")).not.toBeInTheDocument();
    });
  });

  describe("MESSAGE flush", () => {
    it("clears the live buffer when the assistant MESSAGE arrives", async () => {
      const { setItems } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing...")).toBeInTheDocument();
      });

      setItems([
        USER_TURN,
        {
          kind: "agent_text",
          id: "agent-2-0",
          text: "Investigation complete.",
        },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "m2",
          type: "MESSAGE",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              kind: "assistant",
              content: "Investigation complete.",
              parts: [{ type: "text", text: "Investigation complete." }],
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByText("Analyzing...")).not.toBeInTheDocument();
        expect(screen.getByText("Investigation complete.")).toBeInTheDocument();
      });
    });

    // A streamed block keyed by the clock and its saved copy keyed by the turn
    // never merge, so the same sentence is drawn twice.
    it("does not draw a streamed turn twice once its saved copy arrives", async () => {
      const { setItems } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "d1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "s1",
            delta: "Investigation complete.",
            turn: 2,
          },
        });
      });
      await waitFor(() => {
        expect(screen.getByText("Investigation complete.")).toBeInTheDocument();
      });

      // Counting straight after the event would pass on the first poll, against
      // a transcript the server had not answered yet.
      setItems([
        USER_TURN,
        {
          kind: "agent_text",
          id: "agent-2-0",
          text: "Investigation complete.",
          turn: 2,
        },
        {
          kind: "agent_text",
          id: "agent-2-1",
          text: "The saved copy landed.",
          turn: 2,
        },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "d2",
          type: "REPORT_UPDATED",
          payload: { sessionId: "s1" },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("The saved copy landed.")).toBeInTheDocument();
      });
      expect(screen.getAllByText("Investigation complete.")).toHaveLength(1);
    });
  });

  describe("tool call (TRANSCRIPT_ITEM events)", () => {
    it("renders a running call as a row naming the tool and its target", async () => {
      // A running tool means the run is live, so its group is open, not collapsed.
      setup(undefined, true);

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-1",
              toolName: "check_service_status",
              input: { target: "nginx" },
              state: { phase: "running" },
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
        expect(screen.getByText(/nginx/)).toBeInTheDocument();
      });
    });

    it("reads the result on the row once the call completes", async () => {
      setup(undefined, true);

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-1",
              toolName: "check_service_status",
              input: { target: "nginx" },
              state: { phase: "running" },
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m4",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-1",
              toolName: "check_service_status",
              input: {},
              state: {
                phase: "complete",
                result: { status: "stopped", exitCode: 1 },
              },
            },
          },
        });
      });

      // Output is evidence to check rather than the thread to follow, so it
      // collapses until asked for. The row itself is the disclosure.
      const disclosure = await screen.findByRole("button", {
        name: /check_service_status/,
      });
      expect(screen.queryByText(/stopped/)).not.toBeInTheDocument();

      await userEvent.setup().click(disclosure);
      expect(screen.getByText(/stopped/)).toBeInTheDocument();
    });

    it("replaces the right card by toolCallId, leaving the other alone", async () => {
      setup(undefined, true);

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-1",
              toolName: "check_service_status",
              input: { target: "nginx" },
              state: { phase: "running" },
            },
          },
        });
        MockEventSource.latest?.push({
          messageId: "m5",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-2",
              toolName: "list_processes",
              input: { filter: "http" },
              state: { phase: "running" },
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
        expect(screen.getByText("list_processes")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m6",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-2",
              toolName: "check_service_status",
              input: {},
              state: {
                phase: "complete",
                result: { processes: ["nginx", "node"] },
              },
            },
          },
        });
      });

      // Exactly one card gained output: the one the item named. The other is
      // still running, so its row is disabled and cannot be opened.
      const rows = await screen.findAllByRole("button", {
        name: /check_service_status|list_processes/,
      });
      /* aria-disabled, not the native attribute: the trigger stays focusable
         while it is running, so a keyboard reaches it and is told it is busy. */
      const disclosures = rows.filter(
        (r) => r.getAttribute("aria-disabled") !== "true",
      );
      expect(disclosures).toHaveLength(1);

      await userEvent.setup().click(disclosures[0]!);
      expect(screen.getByText(/"nginx"/)).toBeInTheDocument();
    });

    it("ignores items for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "other-session",
            item: {
              kind: "tool_call",
              toolCallId: "tu-99",
              toolName: "should_not_appear",
              input: {},
              state: { phase: "running" },
            },
          },
        });
      });

      expect(screen.queryByText("should_not_appear")).not.toBeInTheDocument();
    });
  });

  describe("working indicator (immediate affordance)", () => {
    it("shows the indicator on send and keeps it through the user-turn persist", async () => {
      const { setItems } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      // The live line and the echoed bubble show the instant the message is
      // sent, so pressing send is never answered by a still page.
      await waitFor(() => {
        expect(screen.getByTestId("working-indicator")).toBeInTheDocument();
      });
      expect(screen.getAllByText("check the db")).toHaveLength(1);

      // Persisting the user's own turn is a MESSAGE, not a terminal: the run is
      // still active, so the indicator stays.
      setItems([
        USER_TURN,
        { kind: "user_turn", id: "user-2-0", text: "check the db" },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "u1",
          type: "MESSAGE",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              kind: "user",
              content: "check the db",
              parts: [{ type: "text", text: "check the db" }],
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("check the db")).toHaveLength(1);
      });
      expect(screen.getByTestId("working-indicator")).toBeInTheDocument();

      // The first assistant token takes over: the indicator gives way to output.
      act(() => {
        MockEventSource.latest?.push({
          messageId: "a1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "s1",
            delta: "Checking the database...",
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText("Checking the database..."),
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId("working-indicator")).not.toBeInTheDocument();
    });

    it("drops the live line when the run goes straight to a tool call", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "restart nginx");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByTestId("working-indicator")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-1",
              toolName: "check_service_status",
              input: { target: "nginx" },
              state: { phase: "running" },
            },
          },
        });
      });

      // The in-flight tool card is the thing to show, so the live line steps
      // aside rather than sitting beneath it saying the same thing.
      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("working-indicator")).not.toBeInTheDocument();
    });
  });

  describe("optimistic echo", () => {
    // The id the view minted for the message it just posted.
    const postedClientId = async (api: Api): Promise<string> =>
      await waitFor(() => {
        const posts = api
          .requests("/api/sessions/s1/messages")
          .filter((r) => r.method === "POST");
        const body = posts.at(-1)?.body as { clientMessageId?: string };
        if (body?.clientMessageId === undefined) throw new Error("no send yet");
        return body.clientMessageId;
      });

    it("echoes the message instantly and keeps exactly one bubble through the persist", async () => {
      const { setItems, api, qc } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      // The bubble is there before any server event, and the box is cleared.
      expect(screen.getAllByText("check the db")).toHaveLength(1);
      expect(screen.getByRole("textbox")).toHaveValue("");

      // The row's event lands before the refetch that carries it, and the
      // bubble holds through that gap.
      act(() => {
        MockEventSource.latest?.push({
          messageId: "u1",
          type: "MESSAGE",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              kind: "user",
              content: "check the db",
              parts: [{ type: "text", text: "check the db" }],
              timestamp: new Date().toISOString(),
            },
          },
        });
      });
      expect(screen.getAllByText("check the db")).toHaveLength(1);

      setItems([
        USER_TURN,
        {
          kind: "user_turn",
          id: await postedClientId(api),
          text: "check the db",
        },
      ]);
      await act(async () => {
        await qc.invalidateQueries({
          queryKey: sessionQuery("s1").queryKey,
        });
      });

      // The persisted row replaces the echo one-for-one, never both.
      expect(screen.getAllByText("check the db")).toHaveLength(1);
    });

    it("draws a message that repeats the last one as a bubble of its own", async () => {
      setup([{ kind: "user_turn", id: "user-1-0", text: "yes" }]);
      await waitFor(() => {
        expect(screen.getAllByText("yes")).toHaveLength(1);
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "yes");
      await user.click(screen.getByRole("button", { name: /send/i }));

      expect(screen.getAllByText("yes")).toHaveLength(2);
    });

    it("keeps one bubble when the server saves different text than was typed", async () => {
      const { setItems, api, qc } = setup();
      await waitFor(() => {
        expect(screen.getAllByTestId("user-turn")).toHaveLength(1);
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));
      const echoed = screen.getAllByTestId("user-turn")[1];

      // The refetch arrives before any event, carrying the rewritten text.
      setItems([
        USER_TURN,
        {
          kind: "user_turn",
          id: await postedClientId(api),
          text: "check the db, rewritten",
        },
      ]);
      await act(async () => {
        await qc.invalidateQueries({
          queryKey: sessionQuery("s1").queryKey,
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check the db, rewritten")).toBeInTheDocument();
      });
      expect(screen.getAllByTestId("user-turn")).toHaveLength(2);
      // The saved copy takes over the echo's element rather than mounting anew.
      expect(screen.getAllByTestId("user-turn")[1]).toBe(echoed);
    });

    it("sends the report retry with an id of its own and echoes it", async () => {
      const { api } = setup([
        USER_TURN,
        { kind: "report_card", id: "report", state: { phase: "failed" } },
      ]);

      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: /try again/i }),
      );

      expect(await postedClientId(api)).toMatch(UUID_V4);
      expect(screen.getAllByTestId("user-turn")).toHaveLength(2);
    });

    it("rolls back the echo and restores the text when the send never reaches the API", async () => {
      const { cutMessages } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      cutMessages();

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      // Echo and working indicator roll back; the chat input gets the message
      // back. The only remaining bubble is the session's original persisted turn.
      await waitFor(() => {
        expect(screen.getAllByTestId("user-turn")).toHaveLength(1);
        expect(
          screen.queryByTestId("working-indicator"),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("textbox")).toHaveValue("check the db");
        expect(screen.getByRole("textbox")).not.toBeDisabled();
      });
    });
  });

  describe("approval card (INTERRUPT)", () => {
    function pushGatedStart(): void {
      act(() => {
        MockEventSource.latest?.push({
          messageId: "a1",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-gated",
              toolName: "RestartDockerService",
              input: { target: "prod-1/web-01/web-01" },
              state: { phase: "awaiting_human", gate: "approval" },
            },
          },
        });
      });
    }

    it("posts to /respond with decision=approve and disables both buttons on Approve", async () => {
      const { holdRespond } = setup();
      const release = holdRespond();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushGatedStart();

      await waitFor(() => {
        expect(screen.getByTestId("approval-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("approval-card");
      await user.click(within(card).getByRole("button", { name: /restart/i }));

      await waitFor(() => {
        expect(respondedWith()).toContainEqual({
          decision: "approve",
        });
        expect(
          within(card).getByRole("button", { name: /restart/i }),
        ).toBeDisabled();
        expect(
          within(card).getByRole("button", { name: /reject/i }),
        ).toBeDisabled();
      });
      act(() => {
        release();
      });
    });

    // A viewer's button stays on the card but decides nothing; a member's is the same press.
    it.each([
      { role: "member", sends: true },
      { role: "viewer", sends: false },
    ])(
      "a $role pressing Approve sends the decision: $sends",
      async ({ role, sends }) => {
        const { api } = setup([USER_TURN], false, role);
        await screen.findByText("Service is down on web-01");
        pushGatedStart();
        const card = await screen.findByTestId("approval-card");
        const approve = within(card).getByRole("button", { name: /restart/i });

        await userEvent.setup().click(approve);

        if (sends) {
          await waitFor(() =>
            expect(api.requests("/api/sessions/s1/respond")).toHaveLength(1),
          );
        } else {
          expect(approve).toHaveAttribute("aria-disabled", "true");
          expect(api.requests("/api/sessions/s1/respond")).toHaveLength(0);
        }
      },
    );

    it("settles into one row, not a card with a second copy of itself beneath", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushGatedStart();

      await waitFor(() => {
        expect(screen.getByTestId("approval-card")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "a2",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-gated",
              toolName: "RestartDockerService",
              input: { target: "prod-1/web-01/web-01" },
              state: {
                phase: "resolved",
                decision: "approved",
                result: "web-01 restarted",
              },
            },
          },
        });
      });

      // The card is the raised state of this same call, so it goes when the
      // decision does rather than staying and growing a duplicate beneath it.
      await waitFor(() => {
        expect(screen.queryByTestId("approval-card")).not.toBeInTheDocument();
      });

      // A chat keeps its settled run group open, so the one row is there to read
      // and no duplicate may grow beneath it.
      const user = userEvent.setup();
      expect(screen.getAllByText("RestartDockerService")).toHaveLength(1);

      // The row names the call; what it returned is one click inside it.
      const row = screen.getByTestId("tool-call");
      await user.click(within(row).getByRole("button"));
      expect(within(row).getByText(/web-01 restarted/)).toBeInTheDocument();
    });
  });

  describe("reload reconstruction (pending interrupt on load)", () => {
    it("shows an approval card on load for a session with a durable pending approval, with no live event", async () => {
      setup([
        USER_TURN,
        {
          kind: "tool_call",
          toolCallId: "tu-durable",
          toolName: "RestartDockerService",
          input: { target: "prod-1/web-01/web-01" },
          state: { phase: "awaiting_human", gate: "approval" },
        },
      ]);

      await waitFor(() => {
        const card = screen.getByTestId("approval-card");
        expect(
          within(card).getByText("RestartDockerService"),
        ).toBeInTheDocument();
        expect(
          within(card).getByRole("button", { name: /restart/i }),
        ).toBeInTheDocument();
      });
    });

    it("shows a clarification card on load for a session with a durable pending clarification", async () => {
      setup([
        USER_TURN,
        {
          kind: "tool_call",
          toolCallId: "tu-durable-clar",
          toolName: "AskUserQuestion",
          input: {
            question: "Which service first?",
            options: [{ label: "nginx", description: "The web server" }],
          },
          state: { phase: "awaiting_human", gate: "clarification" },
        },
      ]);

      await waitFor(() => {
        const card = screen.getByTestId("clarification-card");
        expect(
          within(card).getByText("Which service first?"),
        ).toBeInTheDocument();
        expect(
          within(card).getByRole("radio", { name: /^nginx$/i }),
        ).toBeInTheDocument();
      });
    });

    it("approving a reconstructed card posts to /respond exactly like a live one", async () => {
      setup([
        USER_TURN,
        {
          kind: "tool_call",
          toolCallId: "tu-durable",
          toolName: "RestartDockerService",
          input: { target: "prod-1/web-01/web-01" },
          state: { phase: "awaiting_human", gate: "approval" },
        },
      ]);

      await waitFor(() => {
        expect(screen.getByTestId("approval-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("approval-card");
      await user.click(within(card).getByRole("button", { name: /restart/i }));

      await waitFor(() => {
        expect(respondedWith()).toContainEqual({
          decision: "approve",
        });
      });
    });
  });

  describe("chat input integration", () => {
    it("disables the chat input while TEXT_MESSAGE_CONTENT events are arriving", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
        expect(
          screen.getByRole("button", { name: /stop/i }),
        ).toBeInTheDocument();
      });
    });

    it("re-enables the chat input once RUN_FINISHED arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m2",
          type: "RUN_FINISHED",
          payload: { sessionId: "s1", reason: "completed" },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).not.toBeDisabled();
        expect(
          screen.getByRole("button", { name: /send/i }),
        ).toBeInTheDocument();
      });
    });

    it("re-enables the chat input when RUN_FAILED arrives (run not left spinning)", async () => {
      const { setItems } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", delta: "Analyzing..." },
        });
      });
      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
      });

      setItems([
        USER_TURN,
        {
          kind: "error_text",
          id: "error-2",
          text: "The model provider had a server problem - this is upstream, not your setup.",
        },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "m-fail",
          type: "RUN_FAILED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              kind: "error",
              content:
                "The model provider had a server problem - this is upstream, not your setup.",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      // The failure reads like any other message in the conversation and the
      // chat input is usable again.
      await waitFor(() => {
        expect(
          screen.getByText(/The model provider had a server problem/),
        ).toBeInTheDocument();
        expect(screen.getByRole("textbox")).not.toBeDisabled();
        expect(
          screen.getByRole("button", { name: /send/i }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("clarification card (INTERRUPT kind=clarification)", () => {
    function pushClarification(inputExtra: object = {}): void {
      act(() => {
        MockEventSource.latest?.push({
          messageId: "c1",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-clar",
              toolName: "AskUserQuestion",
              input: {
                question: "Which service should I investigate first?",
                options: [
                  { label: "nginx", description: "The web server" },
                  { label: "postgres", description: "The database" },
                ],
                ...inputExtra,
              },
              state: { phase: "awaiting_human", gate: "clarification" },
            },
          },
        });
      });
    }

    it("renders question text and option buttons when clarification interrupt arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification();

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      const card = screen.getByTestId("clarification-card");
      expect(
        within(card).getByText("Which service should I investigate first?"),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("radio", { name: /^nginx$/i }),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("radio", { name: /^postgres$/i }),
      ).toBeInTheDocument();
    });

    // The card's number and Enter keys bypass its buttons, so a viewer's answer is stopped further in.
    it("sends a viewer's keyboard answer nowhere", async () => {
      const { api } = setup([USER_TURN], false, "viewer");
      await screen.findByText("Service is down on web-01");
      pushClarification();
      const card = await screen.findByTestId("clarification-card");
      const user = userEvent.setup();

      // The number key picks the option, so the keys reach the card and Enter would answer.
      await user.keyboard("1");
      expect(
        within(card).getByRole("radio", { name: /^nginx$/i }),
      ).toBeChecked();
      await user.keyboard("{Enter}");

      expect(api.requests("/api/sessions/s1/respond")).toHaveLength(0);
    });

    it("selecting an option and submitting posts to /respond with text and disables options", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification();

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("clarification-card");
      await user.click(within(card).getByRole("radio", { name: /^nginx$/i }));
      await user.click(within(card).getByRole("button", { name: /submit/i }));

      await waitFor(() => {
        expect(respondedWith()).toContainEqual({
          text: "nginx",
        });
      });
    });

    it("settles into a row naming the tool, with the exchange inside", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification();

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "c2",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_call",
              toolCallId: "tu-clar",
              toolName: "AskUserQuestion",
              input: {
                question: "Which service should I investigate first?",
              },
              state: {
                phase: "resolved",
                decision: "answered",
                result: "nginx",
              },
            },
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.queryByTestId("clarification-card"),
        ).not.toBeInTheDocument();
      });

      // Nothing the agent said is hidden in a chat, so the settled group is
      // still open and the answered call reads in place.
      const user = userEvent.setup();
      const row = screen.getByTestId("tool-call");
      expect(within(row).getByText("AskUserQuestion")).toBeInTheDocument();

      // The exchange reads whole one click inside the row.
      await user.click(within(row).getByRole("button"));
      expect(
        within(row).getByText(/which service should I investigate first/i),
      ).toBeInTheDocument();
      expect(within(row).getByText("nginx")).toBeInTheDocument();
    });

    it("multiSelect: joins selected options and posts to /respond as text", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification({ multiSelect: true });

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("clarification-card");
      await user.click(
        within(card).getByRole("checkbox", { name: /^nginx$/i }),
      );
      await user.click(
        within(card).getByRole("checkbox", { name: /^postgres$/i }),
      );
      await user.click(within(card).getByRole("button", { name: /submit/i }));

      await waitFor(() => {
        expect(respondedWith()).toContainEqual({
          text: "nginx, postgres",
        });
      });
    });

    /* Answering resumes the run, and the card is drawn from a live-only item,
       so the resume must not wipe the answer out from under the reader. */
    it("keeps an answered card visible as the run resumes", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification();
      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("clarification-card");
      await user.click(within(card).getByRole("radio", { name: /^nginx$/i }));
      await user.click(within(card).getByRole("button", { name: /submit/i }));

      expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      // Working again the moment the answer is sent, so the group never settles
      // and folds itself shut under the reader before the first token.
      expect(screen.getByTestId("working-indicator")).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeDisabled();
      const group = screen.getByTestId("run-group");
      expect(group).toHaveAttribute("data-live");
      expect(group.querySelector("button")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("ignores clarification INTERRUPT for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "c-other",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "other-session",
            toolCallId: "tu-other",
            toolName: "AskUserQuestion",
            input: {},
            incidentId: "inc-other",
            kind: "clarification",
            question: "Should not appear",
            options: [],
          },
        });
      });

      expect(
        screen.queryByTestId("clarification-card"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Should not appear")).not.toBeInTheDocument();
    });
  });

  describe("stream reconnect", () => {
    it("refetches active queries after the event stream reconnects", async () => {
      const { api } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const transcriptFetches = (): number =>
        api.requests("/api/sessions/s1").length;
      const before = transcriptFetches();

      // A drop then reopen: events published during the gap are lost (the feed
      // has no replay), so the provider must invalidate queries to catch up.
      act(() => {
        const es = MockEventSource.latest;
        if (es) es.readyState = MockEventSource.CONNECTING;
        MockEventSource.latest?.onerror?.();
        MockEventSource.latest?.onopen?.();
      });

      await waitFor(() => {
        expect(transcriptFetches()).toBeGreaterThan(before);
      });
    });
  });

  // The stream is this component's own state, so leaving and coming back starts
  // it empty. Without the snapshot saying so, a live run reads as finished.
  describe("rejoining a session that is already running", () => {
    it("shows the run as working and holds the message box closed", async () => {
      setup([USER_TURN], true);

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
      });
      expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    });

    it("leaves the message box open when the snapshot says nothing is running", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });
      expect(screen.getByRole("textbox")).not.toBeDisabled();
    });
  });
});

describe("the Agent page", () => {
  // The name and its chevron are one control, so the disclosure is named by
  // where you are rather than by a label sitting next to it.
  async function openHistory(name: string): Promise<void> {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name }));
  }

  /* The title is refined in the background as the run opens, long before the
     first answer, so the heading takes it the moment it is filed. */
  it("heads the conversation with the title the moment it is refined", async () => {
    setupPage({ path: "/agent/c1" });
    await screen.findByRole("button", { name: "Why is redis restarting?" });

    act(() => {
      MockEventSource.latest?.push({
        messageId: "t-1",
        type: "SESSION_TITLE_UPDATED",
        payload: { sessionId: "c1", title: "Redis OOM Restarts" },
      });
    });

    expect(
      await screen.findByRole("button", { name: "Redis OOM Restarts" }),
    ).toBeInTheDocument();
  });

  it("lists only conversations a person started, grouped by day", async () => {
    const { api } = setupPage();
    await openHistory("New chat");

    const panel = await screen.findByRole("dialog");
    expect(
      within(panel).getByRole("link", { name: /Why is redis restarting\?/ }),
    ).toBeInTheDocument();

    // The request carrying the filter is the behaviour worth pinning. Which day
    // heading a row lands under is the clock's business.
    expect(
      api.requests("/api/sessions?").some((r) => r.path.includes("kind=chat")),
    ).toBe(true);
  });

  // The search is the server's, so the request carries it and the list is its answer.
  it("searches the history as the person types, and opens what they pick", async () => {
    const user = userEvent.setup();
    const { api, router } = setupPage();
    await openHistory("New chat");
    const panel = await screen.findByRole("dialog");

    await user.type(
      within(panel).getByRole("searchbox", { name: "Search conversations" }),
      "redis",
    );

    await waitFor(() => {
      expect(
        within(panel).queryAllByRole("link", { name: /Explain|What does/ }),
      ).toHaveLength(0);
    });
    expect(
      api.requests("/api/sessions?").some((r) => r.path.includes("q=redis")),
    ).toBe(true);

    await user.click(
      within(panel).getByRole("link", { name: /Why is redis restarting\?/ }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/agent/c1"),
    );
  });

  it("copies the conversation as a title and alternating role headings", async () => {
    const user = userEvent.setup();
    const { writeText } = setupPage({ path: "/agent/c1" });

    await user.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy as Markdown" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]?.[0]).toBe(
      "# Why is redis restarting?\n\n" +
        "## User\n\nWhy is redis restarting?\n\n" +
        "## Assistant\n\nIt was OOM-killed at 02:14.\n",
    );
  });

  it("names the chat in its delete confirmation and then deletes it", async () => {
    const user = userEvent.setup();
    const { api, router } = setupPage({ path: "/agent/c1" });

    await user.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Why is redis restarting?");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        api.requests("/api/sessions/c1").some((r) => r.method === "DELETE"),
      ).toBe(true);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/agent"));
  });

  // A ready write-up opens in its own panel beside the chat, so it draws nothing
  // in the conversation column.
  it("draws nothing in the chat for a ready write-up", async () => {
    setup([
      { kind: "user_turn", id: "u1", text: "what happened?" },
      { kind: "report_card", id: "report", state: { phase: "ready" } },
    ]);

    await waitFor(() => {
      expect(screen.getByText("what happened?")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("report-card")).not.toBeInTheDocument();
  });

  it("does not offer to delete a chat a run is still holding", async () => {
    const user = userEvent.setup();
    setupPage({ path: "/agent/c1", running: true });

    await user.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Delete" }),
    ).toHaveAttribute("data-disabled");
  });
});
