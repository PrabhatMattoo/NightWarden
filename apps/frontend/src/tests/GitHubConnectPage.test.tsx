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
import type { GitHubIntegrationStatus } from "@nightwarden/shared";

import { TestProviders } from "./renderWithProviders.js";
import { GitHubConnectPage } from "@/features/integrations/github/GitHubConnectPage";
import { toast } from "@/shared/lib/toast";
import { json, stubApi, type ApiRequest } from "./stubApi";

const NOT_CONFIGURED: GitHubIntegrationStatus = {
  configured: false,
  repo: null,
  expiresAt: null,
  rejection: null,
};

function configuredStatus(
  repo: string,
  expiresInDays = 90,
): GitHubIntegrationStatus {
  return {
    configured: true,
    repo,
    expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
    rejection: null,
  };
}

const TWO_REPOS = {
  repos: [
    { fullName: "acme/api", private: true, pushedAt: null, ownerIsOrg: true },
    {
      fullName: "prabhat/dotfiles",
      private: false,
      pushedAt: null,
      ownerIsOrg: false,
    },
  ],
  hasMore: false,
};

interface MockState {
  status: GitHubIntegrationStatus;
  repos: { status: number; body: unknown };
  // Holds GitHub's answer back until the test releases it.
  reposGate?: Promise<void>;
  bind: { status: number; body?: unknown };
  patch: { status: number; body?: unknown };
}

function answerFrom(state: MockState) {
  return async ({ path, method, body }: ApiRequest): Promise<Response> => {
    if (path.startsWith("/api/integrations/github/repos")) {
      await (state.reposGate ?? Promise.resolve());
      return json(state.repos.body, state.repos.status);
    }
    if (path === "/api/integrations/github") {
      if (method === "POST") {
        const { repo } = body as { token: string; repo: string };
        if (state.bind.status < 400) state.status = configuredStatus(repo);
        return json(state.bind.body ?? state.status, state.bind.status);
      }
      if (method === "PATCH") {
        const { repo } = body as { repo: string };
        if (state.patch.status < 400) state.status = { ...state.status, repo };
        return json(state.patch.body ?? state.status, state.patch.status);
      }
      if (method === "DELETE") {
        state.status = NOT_CONFIGURED;
        return new Response(null, { status: 204 });
      }
      return json(state.status);
    }
    return json({});
  };
}

/* GitHubConnectPage navigates back to /integrations (disconnect and back
   link), so it renders under a memory router with a stub destination. */
function renderConnectRoute(qc: QueryClient) {
  const rootRoute = createRootRoute();
  const connectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/github",
    component: GitHubConnectPage,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([connectRoute, integrationsRoute]),
    history: createMemoryHistory({ initialEntries: ["/integrations/github"] }),
  });
  return render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

function setup(overrides?: Partial<MockState>) {
  const state: MockState = {
    status: NOT_CONFIGURED,
    repos: { status: 200, body: TWO_REPOS },
    bind: { status: 201 },
    patch: { status: 200 },
    ...overrides,
  };
  const api = stubApi(answerFrom(state));
  // The request this page sent to an exact path with a method, if it sent one.
  const sent = (method: string, path: string) =>
    api.requests(path).find((r) => r.method === method && r.path === path);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  renderConnectRoute(qc);
  return { sent, state };
}

async function validate(
  user: ReturnType<typeof userEvent.setup>,
  token = "github_pat_test",
): Promise<void> {
  await user.type(
    await screen.findByLabelText(/personal access token/i),
    token,
  );
  await user.click(screen.getByRole("button", { name: "Validate" }));
}

async function pickRepo(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<void> {
  await user.click(
    await screen.findByRole("combobox", { name: /repository/i }),
  );
  await user.click(await screen.findByRole("option", { name }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toast.clean();
});

describe("GitHubConnectPage - onboarding (not yet connected)", () => {
  it("shows the token deep link and the always-visible classic-token note", async () => {
    setup();

    const mintLink = await screen.findByRole("link", {
      name: /create token on github/i,
    });
    expect(mintLink).toHaveAttribute(
      "href",
      expect.stringContaining("settings/personal-access-tokens/new"),
    );
    expect(
      screen.getByRole("link", { name: /classic token/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /advanced/i }),
    ).not.toBeInTheDocument();
  });

  it("validates the token, collapses to a line asking for the repository, and Change token re-opens it", async () => {
    const user = userEvent.setup();
    setup();

    await validate(user);

    expect(
      await screen.findByText("Choose the repository below"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/personal access token/i),
    ).not.toBeInTheDocument();
    // The row's own description stays once the field collapses.
    expect(screen.getByText(/granted the one repository/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change token" }));

    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
  });

  it("validates, picks a repo, connects, and reflects the connected state in place", async () => {
    const user = userEvent.setup();
    const { sent } = setup();

    await validate(user);
    await pickRepo(user, /acme\/api/i);
    await user.click(
      screen.getByRole("button", { name: "Connect repository" }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Test connection" }),
      ).toBeInTheDocument();
    });

    expect(sent("POST", "/api/integrations/github")?.body).toEqual({
      token: "github_pat_test",
      repo: "acme/api",
    });
  });

  it("auto-selects the repository when the token grants exactly one", async () => {
    const user = userEvent.setup();
    setup({
      repos: {
        status: 200,
        body: {
          repos: [
            {
              fullName: "acme/api",
              private: true,
              pushedAt: null,
              ownerIsOrg: true,
            },
          ],
          hasMore: false,
        },
      },
    });

    await validate(user);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect repository" }),
      ).toBeEnabled();
    });
  });

  it("shows the invalid-token ladder step with a regenerate link", async () => {
    const user = userEvent.setup();
    setup({
      repos: {
        status: 401,
        body: { error: "Token invalid or expired", code: "invalid_token" },
      },
    });

    await validate(user);

    expect(
      await screen.findByText(/token invalid or expired/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /regenerate token on github/i }),
    ).toBeInTheDocument();
  });

  it("surfaces the org-approval link when binding 404s on an org-owned repo", async () => {
    const user = userEvent.setup();
    setup({
      bind: {
        status: 404,
        body: {
          error: "GitHub returned 404 for acme/api",
          code: "repo_not_found",
          orgApprovalUrl:
            "https://github.com/organizations/acme/settings/personal-access-token-requests",
        },
      },
    });

    await validate(user);
    await pickRepo(user, /acme\/api/i);
    await user.click(
      screen.getByRole("button", { name: "Connect repository" }),
    );

    const approvalLink = await screen.findByRole("link", {
      name: /review pending token requests/i,
    });
    expect(approvalLink).toHaveAttribute(
      "href",
      "https://github.com/organizations/acme/settings/personal-access-token-requests",
    );
  });
});

describe("GitHubConnectPage - management (already connected)", () => {
  it("shows the token expiry and the combobox pre-selected to the bound repo, without re-validating", async () => {
    const { sent } = setup({ status: configuredStatus("acme/api", 5) });

    expect(await screen.findByText("Expires in 5 days")).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/personal access token/i),
    ).not.toBeInTheDocument();

    const combobox = await screen.findByRole("combobox", {
      name: /repository/i,
    });
    expect(combobox).toHaveValue("acme/api");

    expect(sent("POST", "/api/integrations/github/repos")?.body).toEqual({
      page: 1,
    });
    expect(
      screen.getByRole("button", { name: "Update repository" }),
    ).toBeDisabled();
  });

  it("brings back the token input when GitHub rejects the stored token, not a Validated line", async () => {
    let answer = (): void => {};
    setup({
      status: configuredStatus("acme/api", 5),
      repos: {
        status: 401,
        body: { error: "Token invalid or expired", code: "invalid_token" },
      },
      reposGate: new Promise((release) => (answer = release)),
    });

    // While GitHub has not answered, the page says it is asking and claims nothing.
    expect(
      await screen.findByText(/checking the token with github/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^expires in/i)).not.toBeInTheDocument();
    answer();

    // The live repos load rejects the stored token, so the page asks for a
    // replacement rather than claiming the old one is valid.
    expect(
      await screen.findByText(/token invalid or expired/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
    expect(screen.queryByText(/^expires in/i)).not.toBeInTheDocument();
  });

  it("changes the repository via the stored token, with no token in the request", async () => {
    const user = userEvent.setup();
    const { sent } = setup({ status: configuredStatus("acme/api") });

    const combobox = await screen.findByRole("combobox", {
      name: /repository/i,
    });
    expect(combobox).toHaveValue("acme/api");

    expect(sent("POST", "/api/integrations/github/repos")?.body).toEqual({
      page: 1,
    });

    const updateButton = screen.getByRole("button", {
      name: "Update repository",
    });
    expect(updateButton).toBeDisabled();

    await pickRepo(user, /prabhat\/dotfiles/i);
    expect(updateButton).toBeEnabled();
    await user.click(updateButton);

    const patchCall = await waitFor(() => {
      const call = sent("PATCH", "/api/integrations/github");
      expect(call).toBeDefined();
      return call;
    });
    expect(patchCall?.body).toEqual({
      repo: "prabhat/dotfiles",
    });
  });

  it("changing the token opens a blank field and reconnects with a full bind, not a rebind", async () => {
    const user = userEvent.setup();
    const { sent } = setup({ status: configuredStatus("acme/api") });

    await screen.findByText(/expires in/i);
    await user.click(screen.getByRole("button", { name: "Change token" }));

    const input = screen.getByLabelText(/personal access token/i);
    expect(input).toHaveValue("");

    await validate(user, "github_pat_new");
    await pickRepo(user, /acme\/api/i);
    await user.click(screen.getByRole("button", { name: "Update repository" }));

    const bindCall = await waitFor(() => {
      const call = sent("POST", "/api/integrations/github");
      expect(call).toBeDefined();
      return call;
    });
    expect(bindCall?.body).toEqual({
      token: "github_pat_new",
      repo: "acme/api",
    });
  });

  it("disconnects and returns to the integrations list", async () => {
    const user = userEvent.setup();
    const { sent } = setup({ status: configuredStatus("acme/api") });

    await screen.findByText(/expires in/i);
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Disconnect" }),
    );

    await screen.findByText(/integrations destination/i);
    expect(sent("DELETE", "/api/integrations/github")).toBeDefined();
  });
});
