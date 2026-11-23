import { useEffect } from "react";
import type {
  QueryClient,
  QueryExecuteOptions,
  QueryKey,
} from "@tanstack/react-query";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import type {
  ErrorComponentProps,
  RouterHistory,
} from "@tanstack/react-router";
import { isAllowed } from "@nightwarden/shared/permissions";
import type { Permission } from "@nightwarden/shared/permissions";
import { AppLayout } from "./AppLayout.js";
import { AcceptInvitePage } from "../features/auth/AcceptInvitePage.js";
import { ForgotPasswordPage } from "../features/auth/ForgotPasswordPage.js";
import { LoginPage } from "../features/auth/LoginPage.js";
import { ResetPasswordPage } from "../features/auth/ResetPasswordPage.js";
import { SetupPage } from "../features/auth/SetupPage.js";
import { IntegrationsPage } from "../features/integrations/IntegrationsPage.js";
import { InvestigationsPage } from "../features/investigations/InvestigationsPage.js";
import { InvestigationWorkspace } from "../features/investigations/InvestigationWorkspace.js";
import { AgentPage } from "../features/session/AgentPage.js";
import { GitHubConnectPage } from "../features/integrations/github/GitHubConnectPage.js";
import { AddRunnerPage } from "../features/integrations/runners/AddRunnerPage.js";
import { RunnerListPage } from "../features/integrations/runners/RunnerListPage.js";
import { AlertSourcePage } from "../features/integrations/alerting/AlertSourcePage.js";
import { MetricsSourcePage } from "../features/integrations/metrics/MetricsSourcePage.js";
import { LokiPage } from "../features/integrations/loki/LokiPage.js";
import { SentryPage } from "../features/integrations/sentry/SentryPage.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { TeamPage } from "../features/settings/TeamPage.js";
import { groupOfSection } from "../features/settings/sections.js";
import { METRICS_SOURCE_KINDS } from "@nightwarden/shared";
import type { RoleName, SessionKind } from "@nightwarden/shared";
import { sessionQuery, sessionsQuery } from "../features/session/queries.js";
import { reportQuery } from "../features/report/queries.js";
import {
  authSessionQuery,
  devicesQuery,
  invitationQuery,
  setupQuery,
  signInOptionsQuery,
} from "../features/auth/queries.js";
import { roleOf } from "../features/auth/useCan.js";
import {
  auditQuery,
  configQuery,
  invitationsQuery,
  mailQuery,
  membersQuery,
  organizationQuery,
  teamsQuery,
} from "../features/settings/queries.js";
import {
  alertSourceQuery,
  githubPreflightQuery,
  githubStatusQuery,
  lokiStatusQuery,
  metricsSourceQuery,
  runnersQuery,
  sentryStatusQuery,
} from "../features/integrations/queries.js";
import { Button } from "../shared/ui/button.js";
import { Rounds } from "../shared/ui/Rounds.js";

/* A route's loader reads what its page needs before the page renders, so a page
   arrives whole. A component suspends only on data its own loader awaited. */
interface RouterContext {
  queryClient: QueryClient;
}

/* Pages ship in the app bundle. It is small, so a per-route chunk only buys a
   loading flash on navigation that costs more than the split saves. */
const LAZY = {
  IntegrationsPage,
  InvestigationsPage,
  InvestigationWorkspace,
  AgentPage,
  GitHubConnectPage,
  AddRunnerPage,
  RunnerListPage,
  AlertSourcePage,
  MetricsSourcePage,
  LokiPage,
  SentryPage,
  SettingsPage,
} as const;

// Shown only once a load outlasts a second, in the page's place; the sidebar stays.
function PagePending(): React.JSX.Element {
  return (
    <div className="flex h-svh items-center justify-center animate-in fade-in duration-(--duration-pending-in)">
      <Rounds />
    </div>
  );
}

function RouteError({ error }: ErrorComponentProps): React.JSX.Element {
  const router = useRouter();
  const { reset } = useQueryErrorResetBoundary();
  // A failed query stays failed until reset, so a retry would only rethrow it.
  useEffect(() => reset(), [reset]);
  return (
    <div className="flex h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="type-display">Something went wrong</h1>
        <p className="type-body text-ink-muted">
          {error instanceof Error
            ? error.message
            : "An unexpected error occurred."}
        </p>
      </div>
      <Button variant="secondary" onClick={() => void router.invalidate()}>
        Try again
      </Button>
    </div>
  );
}

/* The session as the cache holds it. A check that itself fails reads as signed
   out, so a broken session route lands on the login page rather than a spinner. */
async function readAuthSession(queryClient: QueryClient) {
  try {
    return await queryClient.query({
      ...authSessionQuery(),
      staleTime: "static",
    });
  } catch {
    queryClient.setQueryData(authSessionQuery().queryKey, null);
    return null;
  }
}

// A fresh install has no account to log in to, so a visitor with no session starts at setup.
async function setupRequired(queryClient: QueryClient): Promise<boolean> {
  const status = await queryClient.query({
    ...setupQuery(),
    staleTime: "static",
  });
  return status.required;
}

// Read through the cache: fetched when absent, taken as it stands when present.
async function need<TData, TError, TKey extends QueryKey>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<TData, TError, TData, TData, TKey>,
): Promise<void> {
  await queryClient.query({ ...options, staleTime: "static" });
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  errorComponent: RouteError,
});

/* Only a path inside this app is kept: "//host" and a backslash would let a link
   send someone who just signed in to another site. */
function appPath(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
    ? value
    : undefined;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  /* Where to go once signed in, such as back to an invitation. The router keeps a key
     the result leaves out, so a refused value is set to undefined rather than dropped. */
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string | undefined } => ({
    redirect: appPath(search["redirect"]),
  }),
  beforeLoad: async ({ context, search }) => {
    if ((await readAuthSession(context.queryClient)) !== null) {
      if (search.redirect !== undefined) {
        throw redirect({ href: search.redirect });
      }
      throw redirect({ to: "/" });
    }
    if (await setupRequired(context.queryClient)) {
      throw redirect({ to: "/setup" });
    }
  },
  component: LoginPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: async ({ context }) => {
    if (!(await setupRequired(context.queryClient))) {
      throw redirect({ to: "/login" });
    }
  },
  component: SetupPage,
});

// Signed out by nature, so neither page checks the session.
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, signInOptionsQuery()),
  component: ForgotPasswordPage,
});

// Better Auth sends the person here with `token` on a good link and `error` on a bad one.
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: (
    search: Record<string, unknown>,
  ): { token?: string; error?: string } => ({
    ...(typeof search["token"] === "string" && { token: search["token"] }),
    ...(typeof search["error"] === "string" && { error: search["error"] }),
  }),
  component: ResetPasswordPage,
});

// Pathless layout: nests every authenticated page so the session is checked
// once, here, instead of each page route checking it itself.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context }) => {
    const session = await readAuthSession(context.queryClient);
    if (session === null) {
      throw redirect({
        to: (await setupRequired(context.queryClient)) ? "/setup" : "/login",
      });
    }
    const role = roleOf(session);
    // The sidebar names the organization; the layout turns away an account with no membership.
    if (role !== null) {
      await need(context.queryClient, organizationQuery());
    }
    // Every route below decides what its person may open from this, so none asks again.
    return { role };
  },
  component: AppLayout,
});

/* A page a person's role can never use is not offered to them, so a link to it
   leads somewhere they can be instead of to a screen of refusals. */
function requires(
  permission: Permission,
  to: "/investigations" | "/integrations/docker" | "/integrations/kubernetes",
) {
  return ({ context }: { context: { role: RoleName | null } }): void => {
    if (!isAllowed(context.role, permission)) throw redirect({ to });
  };
}

// Pathless: the chat is for whoever may start a run, and a viewer has none to start.
const chatRoute = createRoute({
  getParentRoute: () => appRoute,
  id: "chat",
  beforeLoad: requires({ session: ["run"] }, "/investigations"),
});

// Pathless: what the integration pages share is who may open them.
const integrationAccessRoute = createRoute({
  getParentRoute: () => appRoute,
  id: "integration-access",
  beforeLoad: requires({ integration: ["read"] }, "/investigations"),
});

// What the agent found while the user slept is what they came for.
const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/investigations" });
  },
});

// Every session list page the route shows, read before the page renders.
async function needSessions(
  queryClient: QueryClient,
  kind: SessionKind,
): Promise<void> {
  await queryClient.infiniteQuery({
    ...sessionsQuery(kind),
    staleTime: "static",
  });
}

/* The flag the row carries from creation, at its own freshness so a copy just
   invalidated is asked again. One the API cannot answer for is left to the page. */
async function readSession(queryClient: QueryClient, sessionId: string) {
  return await queryClient.query(sessionQuery(sessionId)).catch(() => null);
}

// What a session is decides its route when it is created, so nothing crosses
// between the two families and nothing has to survive the crossing.
const agentRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: "/agent",
  // The history popover's list counts as page data, so it opens already filled.
  loader: ({ context: { queryClient } }) => needSessions(queryClient, "chat"),
  component: LAZY.AgentPage,
});

/* What a session is decided its route when it was created, so a link that names
   the other one is answered by sending the reader where the session lives. */
const agentSessionRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: "/agent/$id",
  loader: async ({ context: { queryClient }, params }) => {
    const [session] = await Promise.all([
      readSession(queryClient, params.id),
      needSessions(queryClient, "chat"),
    ]);
    if (session?.investigation === true) {
      throw redirect({ to: "/investigations/$id", params });
    }
  },
  component: LAZY.AgentPage,
});

const investigationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/investigations/$id",
  loader: async ({ context: { queryClient }, params }) => {
    const [session] = await Promise.all([
      readSession(queryClient, params.id),
      need(queryClient, reportQuery(params.id)),
      needSessions(queryClient, "investigation"),
    ]);
    if (session?.investigation === false) {
      throw redirect({ to: "/agent/$id", params });
    }
  },
  component: LAZY.InvestigationWorkspace,
});

const investigationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/investigations",
  loader: ({ context: { queryClient } }) =>
    needSessions(queryClient, "investigation"),
  component: LAZY.InvestigationsPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations",
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      need(queryClient, githubStatusQuery()),
      need(queryClient, runnersQuery()),
      need(queryClient, alertSourceQuery("alertmanager")),
      need(queryClient, alertSourceQuery("grafana")),
      need(queryClient, metricsSourceQuery()),
      need(queryClient, lokiStatusQuery()),
      need(queryClient, sentryStatusQuery()),
    ]),
  component: LAZY.IntegrationsPage,
});

const githubConnectRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/github",
  /* Our own data only. The repositories are GitHub's answer, which can take
     seconds, so the page opens and that section waits in place. */
  loader: ({ context: { queryClient, role } }) =>
    Promise.all([
      need(queryClient, githubStatusQuery()),
      // The host check is for whoever can connect; reading it is refused to a member.
      isAllowed(role, { integration: ["manage"] }) &&
        need(queryClient, githubPreflightQuery()),
    ]),
  component: LAZY.GitHubConnectPage,
});

// Docker hosts and Kubernetes clusters install and address differently, so they
// are two integrations served by one list and wizard, keyed on the route.
const dockerHostsRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/docker",
  loader: ({ context: { queryClient } }) => need(queryClient, runnersQuery()),
  component: () => <LAZY.RunnerListPage platform="docker" />,
});

const addDockerHostRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/docker/add",
  beforeLoad: requires({ runner: ["manage"] }, "/integrations/docker"),
  loader: ({ context: { queryClient } }) => need(queryClient, runnersQuery()),
  component: () => <LAZY.AddRunnerPage platform="docker" />,
});

const kubernetesClustersRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/kubernetes",
  loader: ({ context: { queryClient } }) => need(queryClient, runnersQuery()),
  component: () => <LAZY.RunnerListPage platform="kubernetes" />,
});

const addKubernetesClusterRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/kubernetes/add",
  beforeLoad: requires({ runner: ["manage"] }, "/integrations/kubernetes"),
  loader: ({ context: { queryClient } }) => need(queryClient, runnersQuery()),
  component: () => <LAZY.AddRunnerPage platform="kubernetes" />,
});

const alertmanagerRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/alerting/alertmanager",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, alertSourceQuery("alertmanager")),
  component: () => <LAZY.AlertSourcePage kind="alertmanager" />,
});

const grafanaAlertingRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/alerting/grafana",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, alertSourceQuery("grafana")),
  component: () => <LAZY.AlertSourcePage kind="grafana" />,
});

/* One page serves every metrics source, keyed on the product the route names.
   What differs between them is words, which live in METRICS_SOURCE_CONTENT. */
const metricsRoutes = METRICS_SOURCE_KINDS.map((kind) =>
  createRoute({
    getParentRoute: () => integrationAccessRoute,
    path: `/integrations/metrics/${kind}`,
    loader: ({ context: { queryClient } }) =>
      need(queryClient, metricsSourceQuery()),
    component: () => <LAZY.MetricsSourcePage kind={kind} />,
  }),
);

const settingsIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({
      to: "/settings/$section",
      params: { section: "profile" },
    });
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/$section",
  // A section named by a URL is opened only by someone its group admits; the rest land on Profile.
  beforeLoad: ({ context, params }) => {
    const group = groupOfSection(params.section);
    if (group !== undefined && !isAllowed(context.role, group.permission)) {
      throw redirect({
        to: "/settings/$section",
        params: { section: "profile" },
      });
    }
  },
  /* The model list is the provider's own answer, which can take seconds, so the
     page opens and the model field waits in place. */
  loader: ({ context: { queryClient }, params }) => {
    switch (params.section) {
      case "security":
        return need(queryClient, devicesQuery());
      case "general":
        return need(queryClient, organizationQuery());
      case "members":
        // The invite dialog reads the teams and whether mail is set up.
        return Promise.all([
          need(queryClient, membersQuery()),
          need(queryClient, invitationsQuery()),
          need(queryClient, teamsQuery()),
          need(queryClient, mailQuery()),
        ]);
      case "teams":
        return Promise.all([
          need(queryClient, teamsQuery()),
          need(queryClient, membersQuery()),
        ]);
      case "email":
        return need(queryClient, mailQuery());
      case "model-provider":
      case "limits":
      case "sandbox":
        return need(queryClient, configQuery());
      case "audit":
        return queryClient.infiniteQuery({
          ...auditQuery(),
          staleTime: "static",
        });
      default:
        return undefined;
    }
  },
  component: LAZY.SettingsPage,
});

// One team, opened from the Teams list; only the people who see Teams may open it.
const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/teams/$teamId",
  beforeLoad: ({ context }) => {
    const group = groupOfSection("teams");
    if (group !== undefined && !isAllowed(context.role, group.permission)) {
      throw redirect({
        to: "/settings/$section",
        params: { section: "profile" },
      });
    }
  },
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      need(queryClient, teamsQuery()),
      need(queryClient, membersQuery()),
    ]),
  component: TeamPage,
});

// Outside the app layout: the person following an invitation link has no session yet.
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  // An existing account joins with its session, so the page needs to know whose it is.
  loader: ({ context: { queryClient }, params }) =>
    Promise.all([
      need(queryClient, invitationQuery(params.token)),
      readAuthSession(queryClient),
    ]),
  component: AcceptInvitePage,
});

const lokiRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/loki",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, lokiStatusQuery()),
  component: LAZY.LokiPage,
});

const sentryRoute = createRoute({
  getParentRoute: () => integrationAccessRoute,
  path: "/integrations/sentry",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, sentryStatusQuery()),
  component: LAZY.SentryPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  inviteRoute,
  appRoute.addChildren([
    indexRoute,
    chatRoute.addChildren([agentRoute, agentSessionRoute]),
    investigationsRoute,
    investigationRoute,
    integrationAccessRoute.addChildren([
      integrationsRoute,
      githubConnectRoute,
      dockerHostsRoute,
      addDockerHostRoute,
      kubernetesClustersRoute,
      addKubernetesClusterRoute,
      alertmanagerRoute,
      grafanaAlertingRoute,
      ...metricsRoutes,
      lokiRoute,
      sentryRoute,
    ]),
    settingsIndexRoute,
    settingsRoute,
    teamRoute,
  ]),
]);

export function createAppRouter({
  queryClient,
  history,
}: {
  queryClient: QueryClient;
  history?: RouterHistory;
}) {
  return createRouter({
    routeTree,
    context: { queryClient },
    ...(history !== undefined && { history }),
    defaultPendingComponent: PagePending,
    // A load under a second shows nothing; once shown, the indicator stays long enough to read.
    defaultPendingMs: 1000,
    defaultPendingMinMs: 500,
    defaultErrorComponent: RouteError,
    // The query cache owns freshness, so the router re-asks it on every preload.
    defaultPreloadStaleTime: 0,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
