import { render, screen, waitFor, within } from "@testing-library/react";
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
import { signedIn } from "./auth-session.js";
import { TestProviders } from "./renderWithProviders.js";
import { json, stubApi } from "./stubApi.js";
import type { AlertSourceKind, RunnerRecord } from "@nightwarden/shared";

import { AlertSourcePage } from "../features/integrations/alerting/AlertSourcePage.js";

const ROTATED_TOKEN = "nwi_rotated999999999999999999999999";
const INGEST_URL = "http://api.test/alerts/ingest";

function dockerRunner(name: string): RunnerRecord {
  return {
    id: name,
    platform: "docker" as const,
    serverName: name,
    hostname: `${name}-host`,
    createdAt: "2024-01-01T00:00:00Z",
    online: true,
    lastSeen: new Date().toISOString(),
    manifest: {
      platform: "docker" as const,
      hostname: `${name}-host`,
      runnerVersion: "2.0.0",
      services: [],
    },
  };
}

function renderAlertmanagerRoute(kind: AlertSourceKind = "alertmanager") {
  const rootRoute = createRootRoute();
  const alertmanagerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/alerting/alertmanager",
    component: () => <AlertSourcePage kind={kind} />,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([alertmanagerRoute, integrationsRoute]),
    history: createMemoryHistory({
      initialEntries: ["/integrations/alerting/alertmanager"],
    }),
  });

  const qc = signedIn(
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    }),
  );

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
    configured?: boolean;
    lastReceivedAt?: string | null;
    runners?: RunnerRecord[];
    kind?: AlertSourceKind;
  } = {},
) {
  const {
    configured = false,
    lastReceivedAt = null,
    runners = [dockerRunner("prod-web-01")],
    kind = "alertmanager",
  } = opts;
  const base = `/api/integrations/alerting/${kind}`;
  let rotated = false;

  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

  const api = stubApi(({ path, method }) => {
    if (path === "/api/runners") return json(runners);
    if (path === `${base}/credential` && method === "POST") {
      rotated = true;
      return json({ token: ROTATED_TOKEN }, 201);
    }
    if (path === base && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (path === base)
      return json({
        configured: configured || rotated,
        ingestUrl: INGEST_URL,
        lastReceivedAt: rotated ? null : lastReceivedAt,
      });
    return json({});
  });

  const view = renderAlertmanagerRoute(kind);
  return { api, clipboardWrite, view };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AlertSourcePage", () => {
  it("shows the whole setup without minting, then reveals the credential once", async () => {
    const user = userEvent.setup();
    const { api } = setup({ configured: false });

    const generateButton = await screen.findByRole("button", {
      name: /generate secret/i,
    });
    /* Viewing never mints. The URL is knowable before any secret exists, and
       so is the scheme, which the setup sentence carries. */
    expect(screen.getByText(/alerts\/ingest/)).toBeInTheDocument();
    expect(screen.getByText(/Bearer/)).toBeInTheDocument();
    expect(
      api.requests("/api/integrations/alerting/alertmanager/credential"),
    ).toEqual([]);

    await user.click(generateButton);

    await screen.findByText(new RegExp(ROTATED_TOKEN));
    expect(screen.getByText(/not shown again/i)).toBeInTheDocument();
    // Mid-setup is a step to finish, so the actions wait until it is saved.
    expect(
      screen.queryByRole("button", { name: "Rotate secret" }),
    ).not.toBeInTheDocument();
  });

  it("hides the credential for good once it has been saved, offering no way back", async () => {
    const user = userEvent.setup();
    setup({ configured: false });

    await user.click(
      await screen.findByRole("button", { name: /generate secret/i }),
    );
    await screen.findByText(new RegExp(ROTATED_TOKEN));

    await user.click(screen.getByRole("button", { name: /i've saved it/i }));

    await waitFor(() => {
      expect(
        screen.queryByText(new RegExp(ROTATED_TOKEN)),
      ).not.toBeInTheDocument();
    });
    // Nothing on the page can fetch it back; rotating is the only way to a
    // working credential again.
    expect(
      screen.queryByRole("button", { name: /show token/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Rotate secret" }),
    ).toBeInTheDocument();
  });

  /* The URL is handed over as text with its button beside it, and the button says
     "Copied" only once the clipboard holds it, or says so when it could not. */
  it("copies the webhook URL and reports what actually happened", async () => {
    const user = userEvent.setup();
    const { clipboardWrite } = setup({ configured: true });

    expect(await screen.findByText(INGEST_URL)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Copy the webhook URL" }),
    );
    expect(clipboardWrite).toHaveBeenCalledWith(INGEST_URL);
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");

    clipboardWrite.mockRejectedValueOnce(new Error("denied"));
    await user.click(
      screen.getByRole("button", { name: "Copy the webhook URL" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Could not copy"),
    );
  });

  it("delivery state: Receiving with a relative time once an alert has landed", async () => {
    setup({
      configured: true,
      lastReceivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });

    expect(await screen.findByText("Receiving")).toHaveClass("text-ok");
    expect(screen.getByText("Last alert 2h ago")).toBeInTheDocument();
  });

  it("rotating confirms in a dialog, then shows the new credential once", async () => {
    const user = userEvent.setup();
    setup({ configured: true, lastReceivedAt: "2026-07-17T01:00:00.000Z" });

    // The consequence lives in the dialog; nothing mints until confirmed.
    await user.click(
      await screen.findByRole("button", { name: "Rotate secret" }),
    );
    expect(
      await screen.findByText(/stops delivering until you paste/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(ROTATED_TOKEN)),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^rotate$/i }));

    await screen.findByText(new RegExp(ROTATED_TOKEN));
    expect(screen.getByText(/not shown again/i)).toBeInTheDocument();
    // Post-rotate the user is mid-setup again, so the actions wait.
    expect(
      screen.queryByRole("button", { name: "Rotate secret" }),
    ).not.toBeInTheDocument();
  });

  it("disconnects, which is the revoke the page never had", async () => {
    const user = userEvent.setup();
    const { api } = setup({ configured: true });

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: /^disconnect$/i }),
    );

    await waitFor(() => {
      expect(
        api
          .requests("/api/integrations/alerting/alertmanager")
          .some((request) => request.method === "DELETE"),
      ).toBe(true);
    });
  });
});
