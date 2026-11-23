import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { signedIn } from "./auth-session.js";
import { TestProviders } from "./renderWithProviders.js";
import { json, stubApi } from "./stubApi.js";
import type { RunnerRecord } from "@nightwarden/shared";

import { AddRunnerPage } from "../features/integrations/runners/AddRunnerPage.js";

const GENERATED_TOKEN = {
  id: "new-token-uuid",
  token: "nwr_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345",
  platform: "docker" as const,
  label: null,
  createdAt: new Date().toISOString(),
};

// Whatever the row's platform calls for; the wizard renders it without reading it.
const INSTALL_SCRIPT = "#!/bin/sh\necho install-docker";

const AWAITING_RUNNER: RunnerRecord = {
  id: "new-token-uuid",
  platform: "docker" as const,
  serverName: "web-01",
  hostname: null,
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: null,
  manifest: null,
};

const CONNECTED_RUNNER: RunnerRecord = {
  id: "new-token-uuid",
  platform: "docker" as const,
  serverName: "web-01",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date().toISOString(),
  manifest: null,
};

/* The page is a routed screen with a navigation guard, so the seam is the route:
   a memory router with a stub destination, left through the breadcrumb. */
function renderAddServerRoute() {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const addRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker/add",
    component: () => <AddRunnerPage platform="docker" />,
  });
  const runnerServersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker",
    component: () => <div>Runner servers destination</div>,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const alertmanagerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/alerting/alertmanager",
    component: () => <div>Alertmanager destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      addRoute,
      runnerServersRoute,
      integrationsRoute,
      alertmanagerRoute,
    ]),
    history: createMemoryHistory({
      initialEntries: ["/integrations/docker/add"],
    }),
  });

  const qc = signedIn(
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    }),
  );

  const view = render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );

  return { router, ...view };
}

function setup(opts: { runners?: RunnerRecord[] } = {}) {
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

  const runners = opts.runners ?? [AWAITING_RUNNER];

  const api = stubApi(({ path, method }) => {
    if (path === "/api/runners" && method === "POST")
      return json(GENERATED_TOKEN, 201);
    if (path === "/api/runners") return json(runners);
    if (path.startsWith("/api/runners/") && method === "DELETE")
      return new Response(null, { status: 204 });
    if (path === "/api/runners/install") return new Response(INSTALL_SCRIPT);
    return json({});
  });
  const mints = () =>
    api.requests("/api/runners").filter((r) => r.method === "POST");
  const revokes = () =>
    api.requests("/api/runners/").filter((r) => r.method === "DELETE");

  return { api, mints, revokes, ...renderAddServerRoute() };
}

// The platform comes from the route, so the first step only asks for a name.
async function startInstall(
  user: ReturnType<typeof userEvent.setup>,
  opts: { name?: string } = {},
): Promise<void> {
  const { name = "test-runner" } = opts;
  await user.type(
    await screen.findByRole("textbox", { name: /server name/i }),
    name,
  );
  await user.click(
    screen.getByRole("button", { name: /generate install command/i }),
  );
}

// What the runner sees opens on its own once it has dialled in.
async function startAndConnect(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await startInstall(user);
  await screen.findByRole("heading", { name: "What it sees" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddRunnerPage", () => {
  describe("the install command", () => {
    // The platform comes from the route, and the row is the only place it survives.
    it("mints one token for the typed name on the route's platform, then shows the install command", async () => {
      const user = userEvent.setup();
      const { mints } = setup();

      await startInstall(user, { name: "prod-web-01" });

      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });
      expect(mints()).toHaveLength(1);
      expect(mints()[0]?.body).toMatchObject({
        serverName: "prod-web-01",
        platform: "docker",
      });
    });

    // A different name needs a different token, so the minted one is revoked.
    it("revokes the minted token and reopens the name when it is changed", async () => {
      const user = userEvent.setup();
      const { revokes } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await screen.findByText(/install-docker/);
      await user.click(
        screen.getByRole("button", { name: /change the name/i }),
      );

      await waitFor(() => {
        expect(revokes().map((r) => r.path)).toEqual([
          `/api/runners/${GENERATED_TOKEN.id}`,
        ]);
      });
      expect(screen.getByRole("textbox", { name: /server name/i })).toHaveValue(
        "web-01",
      );
    });

    it("fetches the install artifact from the one platform-agnostic endpoint", async () => {
      const user = userEvent.setup();
      const { api } = setup();

      await startInstall(user, { name: "web-01" });

      await waitFor(() => {
        expect(
          api
            .requests("/api/runners/install")
            .map((r) => r.headers.get("authorization")),
        ).toEqual([`Bearer ${GENERATED_TOKEN.token}`]);
      });
    });
  });

  describe("once the runner connects", () => {
    it("lists the identity keys the runner advertises, dispatching nothing", async () => {
      const user = userEvent.setup();
      const { api } = setup({
        runners: [
          {
            ...CONNECTED_RUNNER,
            manifest: {
              platform: "docker" as const,
              hostname: "web-host",
              runnerVersion: "2.0.0",
              services: [
                {
                  identity: { project: "encodr", service: "cache" },
                  target: "prod-1/encodr/cache",
                  status: "running",
                },
              ],
            },
          },
        ],
      });
      await startAndConnect(user);

      expect(screen.getByText("prod-1/encodr/cache")).toBeInTheDocument();

      // Checking the wiring must not start an investigation or spend a token.
      expect(api.requests("/api/alerts")).toEqual([]);
    });

    it("warns when the runner connected but sees nothing", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });
      await startAndConnect(user);

      expect(screen.getByText(/no services detected/i)).toBeInTheDocument();
    });

    it("confirms, deletes the minted token, and navigates when leaving before the runner connects", async () => {
      const user = userEvent.setup();
      const { revokes } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("link", { name: /back to integrations/i }),
      );

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^leave setup$/i }),
      );

      await waitFor(() => {
        expect(revokes().map((r) => r.path)).toEqual([
          `/api/runners/${GENERATED_TOKEN.id}`,
        ]);
      });
      expect(
        await screen.findByText(/integrations destination/i),
      ).toBeInTheDocument();
    });

    it("stays on the page and keeps the token when the leave prompt is declined", async () => {
      const user = userEvent.setup();
      const { revokes } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("link", { name: /back to integrations/i }),
      );

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^cancel$/i }),
      );

      // Declining keeps the page on screen rather than reaching a destination.
      expect(
        screen.queryByText(/integrations destination/i),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      expect(revokes()).toEqual([]);
    });

    it("leaves without a prompt and keeps the token once the runner has connected", async () => {
      const user = userEvent.setup();
      const { revokes } = setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await screen.findByRole("heading", { name: "What it sees" });

      await user.click(screen.getByRole("link", { name: /docker hosts/i }));

      expect(
        await screen.findByText(/runner servers destination/i),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(revokes()).toEqual([]);
    });
  });
});
