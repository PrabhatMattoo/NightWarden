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
import { AppLayout } from "./AppLayout.js";
import { LoginPage } from "../features/auth/LoginPage.js";
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
import { METRICS_SOURCE_KINDS } from "@nightwarden/shared";
import type { SessionKind } from "@nightwarden/shared";
import { sessionQuery, sessionsQuery } from "../features/session/queries.js";
import { reportQuery } from "../features/report/queries.js";
import {
  authStatusQuery,
  devicesQuery,
  isSignedIn,
  SIGNED_OUT,
} from "../features/auth/queries.js";
import { configQuery } from "../features/settings/queries.js";
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
   out, so a broken status route lands on the login page rather than a spinner. */
async function readAuthStatus(queryClient: QueryClient) {
  try {
    return await queryClient.query({
      ...authStatusQuery(),
      staleTime: "static",
    });
  } catch {
    queryClient.setQueryData(authStatusQuery().queryKey, SIGNED_OUT);
    return SIGNED_OUT;
  }
}

// Read through the cache: fetched when absent, taken as it stands when present.
async function need<TData, TKey extends QueryKey>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<TData, Error, TData, TData, TKey>,
): Promise<void> {
  await queryClient.query({ ...options, staleTime: "static" });
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  errorComponent: RouteError,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: async ({ context }) => {
    if (isSignedIn(await readAuthStatus(context.queryClient))) {
      throw redirect({ to: "/" });
    }
  },
  component: LoginPage,
});

// Pathless layout: nests every authenticated page so the session is checked
// once, here, instead of each page route checking it itself.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context }) => {
    if (!isSignedIn(await readAuthStatus(context.queryClient))) {
      throw redirect({ to: "/login" });
    }
  },
  component: AppLayout,
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
  getParentRoute: () => appRoute,
  path: "/agent",
  // The history popover's list counts as page data, so it opens already filled.
  loader: ({ context: { queryClient } }) => needSessions(queryClient, "chat"),
  component: LAZY.AgentPage,
});

/* What a session is decided its route when it was created, so a link that names
   the other one is answered by sending the reader where the session lives. */
const agentSessionRoute = createRoute({
  getParentRoute: () => appRoute,
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
  getParentRoute: () => appRoute,
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
  getParentRoute: () => appRoute,
  path: "/integrations/github",
  /* Our own data only. The repositories are GitHub's answer, which can take
     seconds, so the page opens and that section waits in place. */
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      need(queryClient, githubStatusQuery()),
      need(queryClient, githubPreflightQuery()),
    ]),
  component: LAZY.GitHubConnectPage,
});

// Docker hosts and Kubernetes clusters install and address differently, so they
// are two integrations served by one list and wizard, keyed on the route.
const dockerHostsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/docker",
  loader: ({ context: { queryClient } }) => need(queryClient, runnersQuery()),
  component: () => <LAZY.RunnerListPage platform="docker" />,
});

const addDockerHostRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/docker/add",
  loader: ({ context: { queryClient } }) => need(queryClient, runnersQuery()),
  component: () => <LAZY.AddRunnerPage platform="docker" />,
});

const kubernetesClustersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/kubernetes",
  loader: ({ context: { queryClient } }) => need(queryClient, runnersQuery()),
  component: () => <LAZY.RunnerListPage platform="kubernetes" />,
});

const addKubernetesClusterRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/kubernetes/add",
  loader: ({ context: { queryClient } }) => need(queryClient, runnersQuery()),
  component: () => <LAZY.AddRunnerPage platform="kubernetes" />,
});

const alertmanagerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/alerting/alertmanager",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, alertSourceQuery("alertmanager")),
  component: () => <LAZY.AlertSourcePage kind="alertmanager" />,
});

const grafanaAlertingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/alerting/grafana",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, alertSourceQuery("grafana")),
  component: () => <LAZY.AlertSourcePage kind="grafana" />,
});

/* One page serves every metrics source, keyed on the product the route names.
   What differs between them is words, which live in METRICS_SOURCE_CONTENT. */
const metricsRoutes = METRICS_SOURCE_KINDS.map((kind) =>
  createRoute({
    getParentRoute: () => appRoute,
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
      params: { section: "provider" },
    });
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/$section",
  /* The model list is the provider's own answer, which can take seconds, so the
     page opens and the model field waits in place. */
  loader: ({ context: { queryClient }, params }) =>
    Promise.all([
      need(queryClient, configQuery()),
      params.section === "account" && need(queryClient, devicesQuery()),
    ]),
  component: LAZY.SettingsPage,
});

const lokiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/loki",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, lokiStatusQuery()),
  component: LAZY.LokiPage,
});

const sentryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/sentry",
  loader: ({ context: { queryClient } }) =>
    need(queryClient, sentryStatusQuery()),
  component: LAZY.SentryPage,
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    agentRoute,
    agentSessionRoute,
    investigationsRoute,
    investigationRoute,
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
    settingsIndexRoute,
    settingsRoute,
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
