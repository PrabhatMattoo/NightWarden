import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";

import { ChatInput } from "@/features/session/transcript/ChatInput";
import { sentBody } from "./sentBody";

// What the API accepts as a client message id.
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setup(
  props: {
    sessionId: string | null;
    isRunning: boolean;
    reopenable?: boolean;
  },
  routePath = "/agent",
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessionId: "new-session-id" }),
    }),
  );

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const root = createRootRoute({ component: Outlet });
  const newRoute = createRoute({
    getParentRoute: () => root,
    path: "/agent",
    component: () => (
      <ChatInput
        sessionId={props.sessionId}
        isRunning={props.isRunning}
        reopenable={props.reopenable ?? false}
      />
    ),
  });
  const sessionRoute = createRoute({
    getParentRoute: () => root,
    path: "/agent/$id",
    component: () => <div>session page</div>,
  });
  const recordRoute = createRoute({
    getParentRoute: () => root,
    path: "/investigations/$id",
    component: () => <div>record page</div>,
  });

  const router = createRouter({
    routeTree: root.addChildren([newRoute, sessionRoute, recordRoute]),
    history: createMemoryHistory({ initialEntries: [routePath] }),
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );

  return { fetchMock: vi.mocked(fetch) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatInput", () => {
  describe("running state (isRunning=true)", () => {
    it("disables the textarea and shows a stop button while agent is running", async () => {
      setup({ sessionId: null, isRunning: true });

      const textarea = await screen.findByRole("textbox");

      expect(textarea).toBeDisabled();
      expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /send/i }),
      ).not.toBeInTheDocument();
    });

    it("posts to /api/sessions/:id/stop when the stop button is clicked", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ sessionId: "s1", isRunning: true });

      const stopButton = await screen.findByRole("button", { name: /stop/i });
      await user.click(stopButton);

      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/stop", {
        method: "POST",
      });
    });
  });

  describe("submit from new session (sessionId=null)", () => {
    // The body carries no kind: typing opens a chat, and an alert opens an
    // investigation.
    it("calls POST /api/chat with the message and its client id, and lands in the chat family", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ sessionId: null, isRunning: false });

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Is nginx down?");
      await user.click(screen.getByRole("button", { name: /send/i }));

      const [, init] = fetchMock.mock.calls.find(
        ([called]) => called === "/api/chat",
      ) as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(sentBody(init)).toEqual({
        message: "Is nginx down?",
        clientMessageId: expect.stringMatching(UUID_V4),
      });

      await screen.findByText("session page");
    });

    it("offers no mode picker", async () => {
      setup({ sessionId: null, isRunning: false });

      await screen.findByRole("textbox");
      expect(screen.queryByRole("button", { name: /^mode:/i })).toBeNull();
    });
  });

  describe("submit from existing session (sessionId set)", () => {
    it("calls POST /api/sessions/:id/messages with the message and its client id", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup(
        { sessionId: "s1", isRunning: false },
        "/agent",
      );

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Why did that tool call fail?");
      await user.click(screen.getByRole("button", { name: /send/i }));

      const [, init] = fetchMock.mock.calls.find(
        ([called]) => called === "/api/sessions/s1/messages",
      ) as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(sentBody(init)).toEqual({
        message: "Why did that tool call fail?",
        clientMessageId: expect.stringMatching(UUID_V4),
      });
    });
  });

  // Reopening is the person's call, and the message they send is its reason.
  describe("reopening a closed investigation", () => {
    it("offers the toggle only while the session can be reopened", async () => {
      setup({ sessionId: "s1", isRunning: false });
      await screen.findByRole("textbox");
      expect(
        screen.queryByRole("button", { name: "Reopen investigation" }),
      ).not.toBeInTheDocument();
    });

    it("sends the message as the reason, and asks for one before it sends", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({
        sessionId: "s1",
        isRunning: false,
        reopenable: true,
      });

      const toggle = await screen.findByRole("button", {
        name: "Reopen investigation",
      });
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");

      const textarea = screen.getByRole("textbox");
      // No reason, no reopen.
      expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();

      await user.type(textarea, "The disk filled again after the fix");
      await user.click(screen.getByRole("button", { name: /send/i }));

      const [, init] = fetchMock.mock.calls.find(
        ([called]) => called === "/api/sessions/s1/reopen",
      ) as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(sentBody(init)).toEqual({
        reason: "The disk filled again after the fix",
        clientMessageId: expect.stringMatching(UUID_V4),
      });
      expect(
        fetchMock.mock.calls.some(
          ([called]) => called === "/api/sessions/s1/messages",
        ),
      ).toBe(false);
    });
  });
});
