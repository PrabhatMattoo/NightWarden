import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { TestProviders } from "./renderWithProviders.js";
import { json, stubApi } from "./stubApi.js";
import type { RunnerRecord } from "@nightwarden/shared";

import { RunnerListPage } from "../features/integrations/runners/RunnerListPage.js";
import { runnersQuery } from "../features/integrations/queries.js";

const NOW = new Date("2024-01-01T12:00:00Z").getTime();

const WEB_RUNNER: RunnerRecord = {
  id: "token-abc123",
  platform: "docker" as const,
  serverName: "web-01",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date(NOW - 30 * 1000).toISOString(),
  manifest: {
    platform: "docker" as const,
    hostname: "web-01",
    runnerVersion: "0.1.0",
    services: [
      {
        identity: { project: "nginx", service: "nginx" },
        target: "web-01/nginx/nginx",
        status: "running",
      },
      {
        identity: { project: "api", service: "api" },
        target: "web-01/api/api",
        status: "running",
      },
    ],
  },
};

/* The page navigates to the add-server route and back to Integrations, so it renders
   under a memory router with stub destination routes. */
function renderRunnerServersRoute(qc: QueryClient) {
  const rootRoute = createRootRoute();
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const runnerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker",
    component: () => <RunnerListPage platform="docker" />,
  });
  const addServerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker/add",
    component: () => <div>Add server destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      integrationsRoute,
      runnerRoute,
      addServerRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/integrations/docker"] }),
  });
  return render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

function setup(runners: RunnerRecord[] = []) {
  const api = stubApi(({ path, method }) => {
    if (path === "/api/runners") return json(runners);
    if (path.startsWith("/api/tokens/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return json({});
  });
  const revokes = () =>
    api.requests("/api/tokens/").filter((r) => r.method === "DELETE");

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  renderRunnerServersRoute(qc);

  return { revokes, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RunnerListPage", () => {
  describe("server list", () => {
    it("shows every advertised identity key in full", async () => {
      const user = userEvent.setup();
      setup([WEB_RUNNER]);

      // The card summarises to a count; opening it shows the whole list, since
      // these are exactly what an alert's labels have to match.
      await user.click(
        await screen.findByRole("button", { name: /2 services/i }),
      );
      expect(await screen.findByText("web-01/nginx/nginx")).toBeInTheDocument();
      expect(screen.getByText("web-01/api/api")).toBeInTheDocument();
    });
  });

  describe("Remove", () => {
    it("revokes the runner's token only once the dialog confirms it", async () => {
      const user = userEvent.setup();
      const { revokes } = setup([WEB_RUNNER]);

      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /remove/i }));
      const dialog = await screen.findByRole("alertdialog");
      expect(revokes()).toEqual([]);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));

      await waitFor(() => {
        expect(revokes().map((r) => r.path)).toEqual([
          `/api/tokens/${WEB_RUNNER.id}`,
        ]);
      });
    });
  });

  describe("polling", () => {
    it("re-polls every 30s, picking up a runner that has gone offline", async () => {
      vi.useFakeTimers();
      let call = 0;
      const { fetchMock } = stubApi(() => {
        call += 1;
        return json([{ ...WEB_RUNNER, online: call === 1 }]);
      });

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      renderRunnerServersRoute(qc);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/^online$/i)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const polled = qc.getQueryData(runnersQuery().queryKey);
      expect(polled?.[0].online).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      // Offline is something to act on, so it says how long it has been.
      expect(screen.getByText(/^offline · last seen/i)).toHaveClass(
        "text-warn",
      );
    });
  });
});
