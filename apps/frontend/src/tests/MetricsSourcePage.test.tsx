import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  MetricsSourceKind,
  MetricsSourceStatus,
} from "@nightwarden/shared";

import { TestProviders } from "./renderWithProviders.js";
import { MetricsSourcePage } from "../features/integrations/metrics/MetricsSourcePage.js";
import { json, stubApi } from "./stubApi";

// The page navigates on disconnect, so it needs a real router around it.
function renderPage(kind: MetricsSourceKind) {
  const rootRoute = createRootRoute();
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/metrics/$kind",
    component: () => <MetricsSourcePage kind={kind} />,
  });
  const integrations = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, integrations]),
    history: createMemoryHistory({
      initialEntries: [`/integrations/metrics/${kind}`],
    }),
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

const NOT_CONNECTED = {
  configured: false,
  kind: null,
  label: null,
  query: null,
  rules: null,
  rejection: null,
};

function connected(over: Partial<MetricsSourceStatus> = {}) {
  return {
    configured: true,
    kind: "victoriametrics",
    label: "VictoriaMetrics",
    query: { url: "http://vmselect:8481", hasAuth: false, hasOrgId: false },
    rules: { url: "http://vmalert:8880", hasAuth: false, hasOrgId: false },
    rejection: null,
    ...over,
  };
}

// Captures what the page posts, and answers the status from what a case sets.
function stubStatus(status: unknown, calls: string[] = []) {
  const posted: unknown[] = [];
  stubApi(({ path, method, body }) => {
    calls.push(`${method} ${path}`);
    if (method === "POST" && body !== undefined) posted.push(body);
    return json(status);
  });
  return posted;
}

describe("MetricsSourcePage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /* One product is connected once, so it is addressed by the product's own
     name and the form has nothing to ask about naming. */
  it("posts both endpoints, and asks for no name", async () => {
    const user = userEvent.setup();
    const posted = stubStatus(NOT_CONNECTED);
    renderPage("victoriametrics");

    await user.type(
      await screen.findByLabelText("Query URL"),
      "http://vmselect:8481/select/0/prometheus",
    );
    await user.type(screen.getByLabelText("Rules URL"), "http://vmalert:8880");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: "victoriametrics",
      query: { url: "http://vmselect:8481/select/0/prometheus" },
      rules: { url: "http://vmalert:8880" },
    });
  });

  /* A supported configuration that costs something specific, so the page names
     the path that still works rather than reporting a plain "Connected". */
  it("says what a source with no rules endpoint costs", async () => {
    stubStatus(connected({ rules: null }));
    renderPage("victoriametrics");

    const rules = await screen.findByLabelText("Rules endpoint");
    expect(rules.textContent).toMatch(
      /reaches Resolved only when your alert source sends a resolved notification/,
    );
    // The header names the product, so the address is what identifies the row.
    expect(screen.getByText("http://vmselect:8481")).toBeInTheDocument();
    // The facts read the same whether connected or not, and the docs name the brand.
    expect(
      screen.getByText("Reads metrics and alert rules"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /VictoriaMetrics docs/ }),
    ).toHaveAttribute("href", "https://docs.victoriametrics.com/");
  });

  /* The state is said once, in the facts card; the actions are buttons under the
     card, with Disconnect apart from the ones that are safe to press. */
  it("says Connected in the facts card and acts through the buttons under the card", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const posted = stubStatus(connected(), calls);
    renderPage("victoriametrics");

    expect(await screen.findByText("Connected")).toHaveClass("text-ok");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(calls).toContain("POST /api/integrations/metrics/test"),
    );

    await user.click(
      screen.getByRole("button", { name: "Update credentials" }),
    );
    // The addresses come back; the credential is typed again.
    expect(await screen.findByLabelText("Query URL")).toHaveValue(
      "http://vmselect:8481",
    );
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      kind: "victoriametrics",
      query: { url: "http://vmselect:8481" },
    });

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      /Disconnect VictoriaMetrics\?/,
    );
  });

  it("says Needs attention when the stored credential was refused", async () => {
    stubStatus(
      connected({
        rejection: {
          reason: "VictoriaMetrics rejected the credential",
          at: "2026-08-02T10:00:00.000Z",
        },
      }),
    );
    renderPage("victoriametrics");

    // Once as the facts card's state, once as the warning that says why.
    const said = await screen.findAllByText("Needs attention");
    expect(said.some((el) => el.classList.contains("text-warn"))).toBe(true);
    expect(
      screen.getByText(/VictoriaMetrics rejected the credential/),
    ).toBeInTheDocument();
  });

  it("names what VictoriaMetrics needs before it serves metric metadata", async () => {
    stubStatus(NOT_CONNECTED);
    renderPage("victoriametrics");

    expect(
      await screen.findByText(/-enableMetadata on your VictoriaMetrics/),
    ).toBeInTheDocument();
  });

  // Grafana Cloud hands out an instance id and a token, so Mimir opens on the
  // pair rather than on a header the user would encode themselves.
  it("opens Mimir on the pair Grafana Cloud gives you", async () => {
    stubStatus(NOT_CONNECTED);
    renderPage("mimir");

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  /* X-Scope-OrgID is Mimir's alone. VictoriaMetrics carries its tenant in the
     URL path, and Prometheus and Thanos have no such concept at all. */
  it("asks for a tenant on Mimir and nowhere else", async () => {
    stubStatus(NOT_CONNECTED);
    renderPage("mimir");
    expect(await screen.findByLabelText("Tenant")).toBeInTheDocument();

    cleanup();
    stubStatus(NOT_CONNECTED);
    renderPage("prometheus");
    await screen.findByLabelText("Query URL");
    expect(screen.queryByLabelText("Tenant")).not.toBeInTheDocument();
  });

  /* One credential reaches the source: the API returns the header and drops a
     basic pair sent beside it, so the form must never send both. */
  it("sends only the credential the chosen method names", async () => {
    const user = userEvent.setup();
    const posted = stubStatus(NOT_CONNECTED);
    renderPage("mimir");

    await user.type(await screen.findByLabelText("Username"), "123456");
    await user.type(screen.getByLabelText("Password"), "glc-token");
    await user.type(
      screen.getByLabelText("Query URL"),
      "http://mimir:8080/prometheus",
    );

    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(
      await screen.findByRole("option", { name: "Bearer token" }),
    );
    await user.type(
      await screen.findByLabelText("Authorization header"),
      "Bearer abc",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: "mimir",
      query: { url: "http://mimir:8080/prometheus", authHeader: "Bearer abc" },
    });
  });
});
