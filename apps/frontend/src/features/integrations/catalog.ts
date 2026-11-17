import { ALERT_SOURCE_KINDS, METRICS_SOURCE_KINDS } from "@nightwarden/shared";

// A catalog row's description stays within 85 characters; the page header's tagline within 70.

const INTEGRATION_SLUGS = [
  "docker",
  "kubernetes",
  ...ALERT_SOURCE_KINDS,
  ...METRICS_SOURCE_KINDS,
  "loki",
  "sentry",
  "github",
] as const;

type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

export interface IntegrationIdentity {
  label: string;
  // The catalog row's name, one line at any width; the header keeps the full label.
  name: string;
  logo: string;
  description: string;
  tagline: string;
  // What an investigation gets from it, as a phrase the meta card reads out.
  provides: string;
  docs: { brand: string; url: string };
}

export const INTEGRATION_CATALOG: Record<IntegrationSlug, IntegrationIdentity> =
  {
    docker: {
      label: "Docker hosts",
      name: "Docker",
      logo: "/logos/docker.svg",
      description:
        "Read container state, logs and stats, and restart a container when you approve it.",
      tagline: "Read container logs and restart what you approve",
      provides: "Reads containers, logs and stats",
      docs: { brand: "Docker", url: "https://docs.docker.com/engine/" },
    },
    kubernetes: {
      label: "Kubernetes clusters",
      name: "Kubernetes",
      logo: "/logos/kubernetes.svg",
      description:
        "Read pod state, events and logs, and restart a workload when you approve it.",
      tagline: "Read pod events and logs, and restart what you approve",
      provides: "Reads pods, events and logs",
      docs: { brand: "Kubernetes", url: "https://kubernetes.io/docs/home/" },
    },
    alertmanager: {
      label: "Prometheus Alertmanager",
      name: "Alertmanager",
      logo: "/logos/prometheus.svg",
      description:
        "Open an investigation when Alertmanager fires, and close it when alerts clear.",
      tagline: "Start an investigation the moment an alert fires",
      provides: "Receives alerts",
      docs: {
        brand: "Alertmanager",
        url: "https://prometheus.io/docs/alerting/latest/configuration/#webhook_config",
      },
    },
    grafana: {
      label: "Grafana Alerting",
      name: "Grafana Alerting",
      logo: "/logos/grafana.svg",
      description:
        "Open an investigation when Grafana Alerting fires, and close it when alerts clear.",
      tagline: "Investigate Grafana alerts the moment they fire",
      provides: "Receives alerts",
      docs: {
        brand: "Grafana",
        url: "https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/",
      },
    },
    prometheus: {
      label: "Prometheus",
      name: "Prometheus",
      logo: "/logos/prometheus.svg",
      description:
        "Query metrics to confirm a symptom, chart it, and see if the rule still fires.",
      tagline: "Query metrics and see when an alert stops firing",
      provides: "Reads metrics and alert rules",
      docs: {
        brand: "Prometheus",
        url: "https://prometheus.io/docs/prometheus/latest/querying/api/",
      },
    },
    victoriametrics: {
      label: "VictoriaMetrics",
      name: "VictoriaMetrics",
      logo: "/logos/victoriametrics.svg",
      description:
        "Query metrics from vmsingle or vmselect, and read alerting rules from vmalert.",
      tagline: "Query metrics and alert rules from VictoriaMetrics",
      provides: "Reads metrics and alert rules",
      docs: {
        brand: "VictoriaMetrics",
        url: "https://docs.victoriametrics.com/",
      },
    },
    mimir: {
      label: "Grafana Mimir",
      name: "Grafana Mimir",
      logo: "/logos/mimir.svg",
      description:
        "Query metrics from self-hosted Mimir or Grafana Cloud Metrics, one tenant at a time.",
      tagline: "Query metrics from Mimir or Grafana Cloud",
      provides: "Reads metrics and alert rules",
      docs: { brand: "Mimir", url: "https://grafana.com/docs/mimir/latest/" },
    },
    thanos: {
      label: "Thanos",
      name: "Thanos",
      logo: "/logos/thanos.svg",
      description:
        "Query metrics across every store behind Thanos, and read the rules it aggregates.",
      tagline: "Query metrics across every store behind Thanos",
      provides: "Reads metrics and alert rules",
      docs: {
        brand: "Thanos",
        url: "https://thanos.io/tip/components/query.md/",
      },
    },
    amp: {
      label: "Amazon Managed Prometheus",
      name: "Amazon Prometheus",
      logo: "/logos/amp.svg",
      description:
        "Query metrics from Amazon Managed Prometheus, signed with your AWS credentials.",
      tagline: "Query metrics from your AWS Prometheus workspace",
      provides: "Reads metrics and alert rules",
      docs: {
        brand: "AWS",
        url: "https://docs.aws.amazon.com/prometheus/latest/userguide/what-is-Amazon-Managed-Service-Prometheus.html",
      },
    },
    loki: {
      label: "Grafana Loki",
      name: "Grafana Loki",
      logo: "/logos/loki.svg",
      description:
        "Read the log lines around an alert and quote them in the report as evidence.",
      tagline: "Search the logs around every alert",
      provides: "Reads logs",
      docs: {
        brand: "Loki",
        url: "https://grafana.com/docs/loki/latest/reference/loki-http-api/",
      },
    },
    sentry: {
      label: "Sentry",
      name: "Sentry",
      logo: "/logos/sentry.svg",
      description:
        "Read the exceptions and stack traces around an alert, and the release each one ran.",
      tagline: "Bring exceptions and releases into every investigation",
      provides: "Reads exceptions and releases",
      docs: { brand: "Sentry", url: "https://docs.sentry.io/api/" },
    },
    github: {
      label: "GitHub",
      name: "GitHub",
      logo: "/logos/github.svg",
      description:
        "Read the repository, verify a fix in a sandbox, and open a draft pull request.",
      tagline: "See recent changes and propose fixes as draft pull requests",
      provides: "Reads commits, pull requests and code",
      docs: {
        brand: "GitHub",
        url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
      },
    },
  };
