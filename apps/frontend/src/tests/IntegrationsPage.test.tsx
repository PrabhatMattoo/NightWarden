import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type {
  GitHubIntegrationStatus,
  RunnerRecord,
} from "@nightwarden/shared";

import { TestProviders } from "./renderWithProviders.js";
import { IntegrationsPage } from "@/features/integrations/IntegrationsPage";

const NOT_CONFIGURED: GitHubIntegrationStatus = {
  configured: false,
  repo: null,
  expiresAt: null,
  rejection: null,
};

const CONFIGURED: GitHubIntegrationStatus = {
  configured: true,
  repo: "acme/api",
  expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  rejection: null,
};

const CONNECTED_RUNNER: RunnerRecord = {
  id: "runner-1",
  platform: "docker" as const,
  serverName: "prod-web-01",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date().toISOString(),
  // A connected runner always has a manifest: the hostname above comes from it,
  // and its platform flags are what decide which of the two lists it belongs to.
  manifest: {
    platform: "docker" as const,
    hostname: "web-01",
    runnerVersion: "2.0.0",
    services: [],
  },
};

/* The catalog navigates to each integration's own route, so it renders under a
   memory router with stub destinations. */
function renderCatalogRoute(qc: QueryClient) {
  const rootRoute = createRootRoute();
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: IntegrationsPage,
  });
  const connectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/github",
    component: () => <div>GitHub connect destination</div>,
  });
  const dockerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker",
    component: () => <div>Docker hosts destination</div>,
  });
  const addDockerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker/add",
    component: () => <div>Add Docker host destination</div>,
  });
  const kubernetesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/kubernetes",
    component: () => <div>Kubernetes clusters destination</div>,
  });
  const addKubernetesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/kubernetes/add",
    component: () => <div>Add Kubernetes cluster destination</div>,
  });
  const alertmanagerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/alerting/alertmanager",
    component: () => <div>Alertmanager destination</div>,
  });
  const metricsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/metrics/prometheus",
    component: () => <div>Prometheus destination</div>,
  });
  const lokiRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/loki",
    component: () => <div>Loki destination</div>,
  });
  const sentryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/sentry",
    component: () => <div>Sentry destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      integrationsRoute,
      connectRoute,
      dockerRoute,
      addDockerRoute,
      kubernetesRoute,
      addKubernetesRoute,
      alertmanagerRoute,
      metricsRoute,
      lokiRoute,
      sentryRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/integrations"] }),
  });
  return render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

function setup(
  opts: {
    github?: GitHubIntegrationStatus;
    runners?: RunnerRecord[];
    ingestConfigured?: boolean;
    grafanaConfigured?: boolean;
    lastReceivedAt?: string | null;
    metrics?: unknown;
    lokiConfigured?: boolean;
    lokiRejected?: boolean;
    sentryConfigured?: boolean;
  } = {},
) {
  const {
    github = NOT_CONFIGURED,
    runners = [],
    ingestConfigured = false,
    grafanaConfigured = false,
    lastReceivedAt = null,
    metrics = {
      configured: false,
      kind: null,
      label: null,
      query: null,
      rules: null,
      rejection: null,
    },
    lokiConfigured = false,
    lokiRejected = false,
    sentryConfigured = false,
  } = opts;

  const fetchMock = vi
    .fn<(url: string, init?: RequestInit) => Promise<unknown>>()
    .mockImplementation((url: string) => {
      const body =
        url === "/api/runners"
          ? runners
          : url === "/api/integrations/alerting/alertmanager"
            ? { configured: ingestConfigured, lastReceivedAt }
            : url === "/api/integrations/alerting/grafana"
              ? { configured: grafanaConfigured, lastReceivedAt: null }
              : url === "/api/integrations/metrics"
                ? metrics
                : url === "/api/integrations/loki"
                  ? {
                      configured: lokiConfigured,
                      url: lokiConfigured ? "http://loki:3100" : null,
                      hasAuth: false,
                      hasOrgId: false,
                      rejection: lokiRejected
                        ? {
                            reason: "Loki rejected the credential",
                            at: new Date().toISOString(),
                          }
                        : null,
                    }
                  : url === "/api/integrations/sentry"
                    ? {
                        configured: sentryConfigured,
                        url: sentryConfigured
                          ? "https://sentry.example.com"
                          : null,
                        orgSlug: sentryConfigured ? "acme" : null,
                        rejection: null,
                      }
                    : github;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      });
    });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = renderCatalogRoute(qc);
  return { fetchMock, qc, view };
}

/* The whole row is the link, so there is no button to find. */
function rowFor(title: string): HTMLElement {
  return screen.getByRole("link", { name: title });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("IntegrationsPage", () => {
  describe("the list", () => {
    it("renders every adapter as a row, across all capabilities", async () => {
      setup();

      await screen.findByText("GitHub");
      for (const title of [
        "Alertmanager",
        "Prometheus",
        "Grafana Loki",
        "Sentry",
        "Docker",
        "GitHub",
      ]) {
        expect(rowFor(title)).toBeInTheDocument();
      }
    });

    /* Connecting never moves a card: it stays in its own section and gains a
       status line, so the grid a person learned stays where they left it. */
    it("keeps a connected integration in its own section with its status", async () => {
      setup({ github: CONFIGURED });

      const code = await screen.findByRole("heading", { name: "Code" });
      const section = within(code.closest("section")!);
      await waitFor(() => {
        expect(
          within(section.getByRole("link", { name: "GitHub" })).getByText(
            "Connected",
          ),
        ).toBeInTheDocument();
      });
      expect(screen.getAllByRole("link", { name: "GitHub" })).toHaveLength(1);
      expect(
        screen.queryByRole("heading", { name: "Connected" }),
      ).not.toBeInTheDocument();
    });

    it("says Needs attention when a stored credential was refused", async () => {
      setup({ lokiConfigured: true, lokiRejected: true });
      const status = await screen.findByText("Needs attention");
      expect(status).toHaveClass("text-warn");
      expect(within(rowFor("Grafana Loki")).getByText("Needs attention")).toBe(
        status,
      );
    });
  });

  describe("GitHub", () => {
    it("says nothing at all when unconnected, and navigates to the connect route", async () => {
      const user = userEvent.setup();
      setup();

      await screen.findByText("GitHub");
      const card = within(rowFor("GitHub"));
      expect(card.queryByText("Not connected")).not.toBeInTheDocument();
      expect(card.queryByText("Connected")).not.toBeInTheDocument();
      expect(card.getByText(/draft pull request/i)).toBeInTheDocument();

      await user.click(rowFor("GitHub"));
      expect(
        await screen.findByText(/github connect destination/i),
      ).toBeInTheDocument();
    });

    it("gains a status line once configured", async () => {
      const user = userEvent.setup();
      setup({ github: CONFIGURED });

      await screen.findByText("GitHub");
      await waitFor(() => {
        expect(
          within(rowFor("GitHub")).getByText("Connected"),
        ).toBeInTheDocument();
      });

      await user.click(rowFor("GitHub"));
      expect(
        await screen.findByText(/github connect destination/i),
      ).toBeInTheDocument();
    });
  });

  describe("Docker hosts and Kubernetes clusters", () => {
    it("offers both, since they install and are addressed differently", async () => {
      setup({ runners: [] });

      expect(await screen.findByText("Docker")).toBeInTheDocument();
      expect(screen.getByText("Kubernetes")).toBeInTheDocument();
    });

    it("routes an empty platform straight into its setup wizard", async () => {
      const user = userEvent.setup();
      setup({ runners: [] });

      await screen.findByText("Kubernetes");
      await user.click(rowFor("Kubernetes"));

      expect(
        await screen.findByText(/add kubernetes cluster destination/i),
      ).toBeInTheDocument();
    });

    it("counts offline hosts in the warning tone", async () => {
      setup({
        runners: [
          CONNECTED_RUNNER,
          { ...CONNECTED_RUNNER, id: "runner-2", online: false },
        ],
      });
      const status = await screen.findByText("2 hosts · 1 offline");
      expect(status).toHaveClass("text-warn");
    });

    it("counts a runner under the platform it advertises, and opens that list", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });

      expect(await screen.findByText("1 host")).toBeInTheDocument();
      expect(
        within(rowFor("Kubernetes")).queryByText(/^\d+ cluster/),
      ).not.toBeInTheDocument();

      await user.click(rowFor("Docker"));
      expect(
        await screen.findByText(/docker hosts destination/i),
      ).toBeInTheDocument();
    });
  });

  describe("Alertmanager", () => {
    it("offers setup when no credential exists and opens the Alertmanager page", async () => {
      const user = userEvent.setup();
      setup({ ingestConfigured: false });

      await screen.findByText("Alertmanager");
      expect(
        within(rowFor("Alertmanager")).queryByText(/receiving|waiting/i),
      ).not.toBeInTheDocument();

      await user.click(rowFor("Alertmanager"));
      expect(
        await screen.findByText(/alertmanager destination/i),
      ).toBeInTheDocument();
    });

    it("reports delivery state, not credential existence: waiting is muted, receiving is green", async () => {
      const { view } = setup({ ingestConfigured: true });
      const waiting = await screen.findByText("Waiting for first alert");
      expect(waiting).toHaveClass("text-ink-muted");
      view.unmount();
      vi.unstubAllGlobals();

      setup({
        ingestConfigured: true,
        lastReceivedAt: new Date().toISOString(),
      });
      const receiving = await screen.findByText("Receiving");
      expect(receiving).toHaveClass("text-ok");
    });

    /* Two senders are two credentials and two deliveries, so a shared status
       would report one sender's first alert on the other's card. */
    it("reports each sender's own delivery, not the other's", async () => {
      setup({
        ingestConfigured: true,
        lastReceivedAt: new Date().toISOString(),
        grafanaConfigured: true,
      });

      await screen.findByText("Grafana Alerting");
      await waitFor(() => {
        expect(
          within(rowFor("Alertmanager")).getByText("Receiving"),
        ).toBeInTheDocument();
      });
      expect(
        within(rowFor("Grafana Alerting")).getByText("Waiting for first alert"),
      ).toBeInTheDocument();
    });
  });

  describe("metrics and logs", () => {
    it("navigates to each page and reports connected once configured", async () => {
      const user = userEvent.setup();
      const { view } = setup({
        metrics: {
          configured: true,
          kind: "prometheus",
          label: "Prometheus",
          query: { url: "http://prom:9090", hasAuth: false, hasOrgId: false },
          rules: { url: "http://prom:9090", hasAuth: false, hasOrgId: false },
          rejection: null,
        },
      });

      await screen.findByText("Prometheus");
      await waitFor(() => {
        expect(
          within(rowFor("Prometheus")).getByText("Connected"),
        ).toBeInTheDocument();
      });
      await user.click(rowFor("Prometheus"));
      expect(
        await screen.findByText(/prometheus destination/i),
      ).toBeInTheDocument();
      view.unmount();
      vi.unstubAllGlobals();

      setup({ lokiConfigured: true });
      await screen.findByText("Grafana Loki");
      await waitFor(() => {
        expect(
          within(rowFor("Grafana Loki")).getByText("Connected"),
        ).toBeInTheDocument();
      });
    });
  });
});
