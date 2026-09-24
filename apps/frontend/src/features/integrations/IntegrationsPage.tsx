import { useSuspenseQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AlertSourceKind, AlertSourceStatus } from "@nightwarden/shared";
import { METRICS_SOURCE_KINDS } from "@nightwarden/shared";

import { Page } from "@/shared/ui/Page";
import { StatusText } from "@/shared/ui/status";
import { IntegrationLogo } from "@/features/integrations/IntegrationHeader";
import { INTEGRATION_CATALOG } from "./catalog";
import {
  alertSourceQuery,
  githubStatusQuery,
  lokiStatusQuery,
  metricsSourceQuery,
  runnersQuery,
  sentryStatusQuery,
} from "./queries";

// Named for what a connection gives an investigation, and the order they read in.
const CATEGORIES = [
  "Alerting",
  "Metrics",
  "Logs",
  "Error tracking",
  "Fleet",
  "Code",
] as const;

type Category = (typeof CATEGORIES)[number];

interface IntegrationRow {
  title: string;
  description: string;
  category: Category;
  logo: string;
  to: string;
  // null renders no status line at all: six repetitions of "Not connected"
  // crowd out the ones that matter. "muted" is configured but not yet proven.
  status: string | null;
  statusVariant?: "success" | "muted";
  // Shown but not actionable: the one slot is filled by another product.
  unavailable?: boolean;
}

/* Each card is the link. When connected, title + status sit as a group beside
   the logo, vertically centred.  When not, the title alone centres. */
function CatalogCard({ row }: { row: IntegrationRow }): React.JSX.Element {
  const body = (
    <>
      {/* Icon row: logo + title (+ status when connected) */}
      <span className="flex items-center gap-3">
        <IntegrationLogo logo={row.logo} className="size-8" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="type-body text-ink-base">{row.title}</span>
          {row.status !== null && (
            <StatusText tone={row.statusVariant === "muted" ? "muted" : "ok"}>
              {row.status}
            </StatusText>
          )}
        </span>
      </span>
      {/* Description, aligned with the logo's left edge. */}
      <span className="type-body text-ink-base">{row.description}</span>
    </>
  );
  const shape =
    "flex flex-col gap-1.5 rounded-card border-hairline border-edge px-4 py-3 transition-colors";
  return row.unavailable === true ? (
    <div aria-label={row.title} className={`${shape} opacity-55`}>
      {body}
    </div>
  ) : (
    <Link
      to={row.to}
      aria-label={row.title}
      className={`group/card ${shape} no-underline hover:bg-hover`}
    >
      {body}
    </Link>
  );
}

// Delivery, not configuration: a card reading Connected on a sender that has
// never delivered is the failure this surface exists to catch.
function alertSourceCard(
  kind: AlertSourceKind,
  status: AlertSourceStatus,
): IntegrationRow {
  const identity = INTEGRATION_CATALOG[kind];
  return {
    title: identity.label,
    description: identity.description,
    category: "Alerting",
    logo: identity.logo,
    to: `/integrations/alerting/${kind}`,
    status: !status.configured
      ? null
      : status.lastReceivedAt !== null
        ? "Receiving"
        : "Waiting for first alert",
    statusVariant: status.lastReceivedAt !== null ? "success" : "muted",
  };
}

export function IntegrationsPage(): React.JSX.Element {
  // One query per sender: each has its own credential and its own delivery
  // proof, so one status line can never stand for the other's.
  const [
    { data: github },
    { data: runners },
    { data: alertmanager },
    { data: grafana },
    { data: metrics },
    { data: loki },
    { data: sentry },
  ] = useSuspenseQueries({
    queries: [
      githubStatusQuery(),
      runnersQuery(),
      alertSourceQuery("alertmanager"),
      alertSourceQuery("grafana"),
      metricsSourceQuery(),
      lokiStatusQuery(),
      sentryStatusQuery(),
    ],
  });

  const connectedRunners = runners.filter((r) => r.hostname !== null);

  // Two entries, because the two install and are addressed differently. An
  // empty platform routes straight to setup rather than an empty list.
  function platformCard(
    platform: "docker" | "kubernetes",
    noun: string,
  ): IntegrationRow {
    const identity = INTEGRATION_CATALOG[platform];
    const count = connectedRunners.filter(
      (r) => r.platform === platform,
    ).length;
    return {
      title: identity.label,
      description: identity.description,
      category: "Fleet",
      logo: identity.logo,
      to:
        count > 0
          ? `/integrations/${platform}`
          : `/integrations/${platform}/add`,
      status: count > 0 ? `${count} ${count === 1 ? noun : `${noun}s`}` : null,
    };
  }

  const rows: IntegrationRow[] = [
    platformCard("docker", "host"),
    platformCard("kubernetes", "cluster"),
    alertSourceCard("alertmanager", alertmanager),
    alertSourceCard("grafana", grafana),
    ...METRICS_SOURCE_KINDS.map((kind): IntegrationRow => {
      const identity = INTEGRATION_CATALOG[kind];
      const connected = metrics.configured && metrics.kind === kind;
      // One source across every product, so connecting one closes the other
      // four rather than offering an action the API would refuse.
      const heldByAnother = metrics.configured && metrics.kind !== kind;
      /* A source with no rules endpoint is connected and still cannot confirm
         a recovery, so the row says which rather than a flat "Connected". */
      const blind = connected && metrics.rules === null;
      return {
        title: identity.label,
        description: identity.description,
        category: "Metrics",
        logo: identity.logo,
        to: `/integrations/metrics/${kind}`,
        unavailable: heldByAnother,
        status: !connected
          ? heldByAnother
            ? `${metrics.label} is connected`
            : null
          : blind
            ? "Connected, no rules endpoint"
            : "Connected",
        statusVariant: blind || heldByAnother ? "muted" : "success",
      };
    }),
    {
      title: INTEGRATION_CATALOG.loki.label,
      description: INTEGRATION_CATALOG.loki.description,
      logo: INTEGRATION_CATALOG.loki.logo,
      category: "Logs",
      to: "/integrations/loki",
      status: loki.configured ? "Connected" : null,
    },
    {
      title: INTEGRATION_CATALOG.sentry.label,
      description: INTEGRATION_CATALOG.sentry.description,
      logo: INTEGRATION_CATALOG.sentry.logo,
      category: "Error tracking",
      to: "/integrations/sentry",
      status: sentry.configured ? "Connected" : null,
    },
    {
      title: INTEGRATION_CATALOG.github.label,
      description: INTEGRATION_CATALOG.github.description,
      logo: INTEGRATION_CATALOG.github.logo,
      category: "Code",
      to: "/integrations/github",
      status: github.configured ? "Connected" : null,
    },
  ];

  // Read in capability order whatever order the rows were built in.
  const shown = [...rows].sort(
    (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
  );

  return (
    <Page
      title="Integrations"
      subtitle="Connect your monitoring, error tracking, and developer platforms to NightWarden."
    >
      <div className="grid grid-cols-3 gap-3">
        {shown.map((row) => (
          <CatalogCard key={row.title} row={row} />
        ))}
      </div>
    </Page>
  );
}
