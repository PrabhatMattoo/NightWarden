import { Fragment } from "react";
import { useSuspenseQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  AlertSourceKind,
  AlertSourceStatus,
  CredentialRejection,
} from "@nightwarden/shared";
import { METRICS_SOURCE_KINDS } from "@nightwarden/shared";

import { Card } from "@/shared/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/shared/ui/item";
import { Page } from "@/shared/ui/Page";
import { StatusText, type StatusTone } from "@/shared/ui/status";
import { IntegrationLogo } from "./IntegrationPage";
import { INTEGRATION_CATALOG } from "./catalog";
import { connectedOn } from "./runners/connectedOn";
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
  // Null renders no status line: repeated "Not connected" crowds out the ones that matter.
  status: { text: string; tone: StatusTone } | null;
  // Shown but not actionable: the one slot is filled by another product.
  unavailable?: boolean;
}

function RowStatus({ row }: { row: IntegrationRow }): React.JSX.Element | null {
  return row.status === null ? null : (
    <StatusText tone={row.status.tone}>{row.status.text}</StatusText>
  );
}

function CatalogRow({ row }: { row: IntegrationRow }): React.JSX.Element {
  const body = (
    <>
      <ItemMedia>
        <IntegrationLogo logo={row.logo} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{row.title}</ItemTitle>
        <ItemDescription className="max-sm:hidden">
          {row.description}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <RowStatus row={row} />
      </ItemActions>
    </>
  );
  return row.unavailable === true ? (
    <Item aria-label={row.title} data-unavailable>
      {body}
    </Item>
  ) : (
    <Item
      render={<Link to={row.to} />}
      aria-label={row.title}
      className="no-underline"
    >
      {body}
    </Item>
  );
}

// One card per section, its rows ruled edge to edge, at every width.
function CatalogSection({
  label,
  rows,
}: {
  label: string;
  rows: IntegrationRow[];
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="type-label">{label}</h2>
      <Card>
        <ItemGroup>
          {rows.map((row, i) => (
            <Fragment key={row.title}>
              {i > 0 && <ItemSeparator />}
              <CatalogRow row={row} />
            </Fragment>
          ))}
        </ItemGroup>
      </Card>
    </section>
  );
}

// A refused credential outranks everything else a row could say.
function credentialStatus(
  configured: boolean,
  rejection: CredentialRejection | null,
): IntegrationRow["status"] {
  if (!configured) return null;
  return rejection === null
    ? { text: "Connected", tone: "ok" }
    : { text: "Needs attention", tone: "warn" };
}

// Delivery, not configuration: a row reading Connected on a sender that has
// never delivered is the failure this surface exists to catch.
function alertSourceRow(
  kind: AlertSourceKind,
  status: AlertSourceStatus,
): IntegrationRow {
  const identity = INTEGRATION_CATALOG[kind];
  return {
    title: identity.name,
    description: identity.description,
    category: "Alerting",
    logo: identity.logo,
    to: `/integrations/alerting/${kind}`,
    status: !status.configured
      ? null
      : status.lastReceivedAt !== null
        ? { text: "Receiving", tone: "ok" }
        : { text: "Waiting for first alert", tone: "muted" },
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

  // Two entries, because the two install and are addressed differently. An
  // empty platform routes straight to setup rather than an empty list.
  function platformRow(
    platform: "docker" | "kubernetes",
    noun: string,
  ): IntegrationRow {
    const identity = INTEGRATION_CATALOG[platform];
    const hosts = connectedOn(runners, platform);
    const offline = hosts.filter((r) => !r.online).length;
    const count = `${hosts.length} ${hosts.length === 1 ? noun : `${noun}s`}`;
    return {
      title: identity.name,
      description: identity.description,
      category: "Fleet",
      logo: identity.logo,
      to:
        hosts.length > 0
          ? `/integrations/${platform}`
          : `/integrations/${platform}/add`,
      status:
        hosts.length === 0
          ? null
          : offline > 0
            ? { text: `${count} · ${offline} offline`, tone: "warn" }
            : { text: count, tone: "ok" },
    };
  }

  const rows: IntegrationRow[] = [
    platformRow("docker", "host"),
    platformRow("kubernetes", "cluster"),
    alertSourceRow("alertmanager", alertmanager),
    alertSourceRow("grafana", grafana),
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
        title: identity.name,
        description: identity.description,
        category: "Metrics",
        logo: identity.logo,
        to: `/integrations/metrics/${kind}`,
        unavailable: heldByAnother,
        status: heldByAnother
          ? { text: `${metrics.label} is connected`, tone: "muted" }
          : connected && metrics.rejection === null && blind
            ? { text: "Connected, no rules endpoint", tone: "muted" }
            : credentialStatus(connected, metrics.rejection),
      };
    }),
    {
      title: INTEGRATION_CATALOG.loki.name,
      description: INTEGRATION_CATALOG.loki.description,
      logo: INTEGRATION_CATALOG.loki.logo,
      category: "Logs",
      to: "/integrations/loki",
      status: credentialStatus(loki.configured, loki.rejection),
    },
    {
      title: INTEGRATION_CATALOG.sentry.name,
      description: INTEGRATION_CATALOG.sentry.description,
      logo: INTEGRATION_CATALOG.sentry.logo,
      category: "Error tracking",
      to: "/integrations/sentry",
      status: credentialStatus(sentry.configured, sentry.rejection),
    },
    {
      title: INTEGRATION_CATALOG.github.name,
      description: INTEGRATION_CATALOG.github.description,
      logo: INTEGRATION_CATALOG.github.logo,
      category: "Code",
      to: "/integrations/github",
      status: credentialStatus(github.configured, github.rejection),
    },
  ];

  return (
    <Page
      title="Integrations"
      subtitle="Connect your monitoring, error tracking, and developer platforms to NightWarden."
    >
      {/* A section appears with its first row: an empty heading reads as unfinished. */}
      {CATEGORIES.map((category) => {
        const inSection = rows.filter((row) => row.category === category);
        return inSection.length === 0 ? null : (
          <CatalogSection key={category} label={category} rows={inSection} />
        );
      })}
    </Page>
  );
}
