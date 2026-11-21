import { z } from "zod";
import { fitList, type Coverage } from "@nightwarden/shared";
import {
  MetricsApiError,
  alertingRules,
  instantQuery,
  metricMetadata,
  metricNames,
  rangeQuery,
  type AlertingRule,
  type MetricsQueryData,
  type MetricsSeries,
} from "../../integrations/metrics/client.js";
import {
  getMetricsSource,
  type MetricsSource,
} from "../../integrations/metrics/sources.js";
import { withStoredCredential } from "../../integrations/credential-health.js";
import { isTransient } from "../../integrations/http.js";
import { alertAnchorFor } from "./alert-anchor.js";
import { apiTool, optionalText } from "./schema.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// API-local by design: these shapes never cross the runner wire.
interface MetricsQueryResult {
  resultType: string;
  series: MetricsSeries[];
  coverage?: Coverage;
  note?: string;
}

export interface MetricsRangeResult extends MetricsQueryResult {
  windowStart: string;
  windowEnd: string;
  stepSeconds: number;
}

interface MetricNamesResult {
  names: string[];
  coverage?: Coverage;
  note: string;
}

interface AlertRulesResult {
  rules: AlertingRule[];
  coverage?: Coverage;
}

const DEFAULT_LOOKBACK_MINUTES = 180;
const MAX_LOOKBACK_MINUTES = 10_080;
const DEFAULT_LOOKFORWARD_MINUTES = 30;
// 20 labelsets is plenty to see a pattern; an unaggregated query over a busy
// fleet returns hundreds, which would drown the transcript.
const MAX_SERIES = 20;
const TARGET_POINTS_PER_SERIES = 200;
// Enough to recognise a naming scheme and pick the right metric; a fleet's full
// name list runs to thousands and would drown the turn that asked for it.
const MAX_METRIC_NAMES = 100;
/* VictoriaMetrics defaults the label endpoints to the day so far where
   Prometheus defaults to all time, so the window is always stated. */
const NAME_WINDOW_MINUTES = 10_080;
const MAX_ALERT_RULES = 50;

/* Prometheus answers a division by zero with these strings, which read like values;
   read as one, "+Inf" says "enormous" where it means "no limit". */
const NON_FINITE = new Set(["+Inf", "-Inf", "NaN"]);

function nonFiniteIn(series: MetricsSeries[]): string[] {
  const found = new Set<string>();
  for (const one of series) {
    for (const [, value] of one.values) {
      if (NON_FINITE.has(value)) found.add(value);
    }
  }
  return [...found];
}

// Capped by count, then by size: a range query returns twenty series of two
// hundred points each, which is several times what one result may occupy.
function capSeries(data: MetricsQueryData): MetricsQueryResult {
  const { items: kept, coverage } = fitList(data.series, {
    keep: "start",
    max: MAX_SERIES,
    kept: "first",
    noun: "series",
    reach: "Aggregate with sum by or topk to fit the series that matter.",
  });
  const notes = [
    ...data.warnings.map(
      (warning) =>
        `The source reported a warning, so this reading may be partial rather than the whole window: ${warning}`,
    ),
    ...(kept.some((series) => series.histogram === true)
      ? [
          "A series marked histogram is a native histogram, and its value is the count of observations rather than a measurement. Read a percentile with histogram_quantile() instead of treating these numbers as the metric.",
        ]
      : []),
    ...(nonFiniteIn(kept).length > 0
      ? [
          `This result carries ${nonFiniteIn(kept).join(" and ")}, which is not a measurement: the query divided by zero or by a value that was absent. Treat those points as undefined rather than as a very large or very small reading, and guard the divisor in the query before reading the ratio.`,
        ]
      : []),
  ];
  return {
    resultType: data.resultType,
    series: kept,
    ...(coverage && { coverage }),
    ...(notes.length > 0 && { note: notes.join(" ") }),
  };
}

// One source or none, so a call names nothing and this only reports absence.
function resolveMetricsSource(): MetricsSource | ToolExecuteResult {
  return (
    getMetricsSource() ?? {
      content:
        "No metrics source is connected. The user can connect one from the Integrations page. Continue without metric evidence.",
      isError: true,
    }
  );
}

// An empty series is not a reading of zero: a metric name that does not exist
// answers identically, and the window is what makes emptiness mean anything.
function withEmpty(
  result: MetricsQueryResult,
  query: string,
  label: string,
): string {
  return [result.note, emptyNote(query, label)].filter(Boolean).join(" ");
}

function emptyNote(query: string, label: string): string {
  return `${label} evaluated "${query}" and it matched no series. That is not a reading of zero: a metric name that does not exist, a label that never had this value, and a genuinely absent target all answer this way. Check the name with ListMetricNames before treating this as evidence of anything.`;
}

function isSource(
  resolved: MetricsSource | ToolExecuteResult,
): resolved is MetricsSource {
  return "capabilities" in resolved;
}

function corrective(err: unknown): ToolExecuteResult {
  if (err instanceof MetricsApiError) {
    if (isTransient(err)) {
      return {
        content: `The metrics source is temporarily unavailable: ${err.message}. Nothing was read. Try the same call again, or continue with other evidence.`,
        isError: true,
      };
    }
    if (err.code === "bad_query") {
      return {
        content: `The source rejected the query: ${err.message}. Fix the PromQL and retry.`,
        isError: true,
      };
    }
    // A shape this cannot read will not read differently on a second attempt.
    if (err.code === "bad_response") {
      return { content: err.message, isError: true };
    }
    return {
      content: `Metrics request failed. ${err.message} If this persists the user must fix the connection on the Integrations page.`,
      isError: true,
    };
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    isError: true,
  };
}

const promql = z.string().trim().min(1, "must be a PromQL string");

const QUERY_METRICS_INPUT = z.object({
  query: promql.meta({ description: "The PromQL expression to evaluate." }),
  at: z.enum(["now", "alert"]).optional().meta({
    description:
      "Which moment to evaluate at. 'now', the default, reads the current value. 'alert' reads the value as of the instant the alert that opened this investigation fired; on a session no alert opened, it means the same as 'now'.",
  }),
});

const QUERY_METRICS_RANGE_INPUT = z.object({
  query: promql.meta({ description: "The PromQL expression to evaluate." }),
  lookbackMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOOKBACK_MINUTES)
    .default(DEFAULT_LOOKBACK_MINUTES)
    .meta({
      description: `How many minutes before the alert to include. From 1 to ${MAX_LOOKBACK_MINUTES}, which is one week.`,
    }),
  lookforwardMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOOKBACK_MINUTES)
    .default(DEFAULT_LOOKFORWARD_MINUTES)
    .meta({
      description: `How many minutes after the alert to include, which is how you tell whether it recovered, never extending past now. From 1 to ${MAX_LOOKBACK_MINUTES}.`,
    }),
  stepSeconds: z
    .number()
    .int()
    .min(1)
    .optional()
    .meta({
      description: `How far apart the sampled points are, in seconds, 1 or more. Omit this and a step is chosen that fits roughly ${TARGET_POINTS_PER_SERIES} points across the window.`,
    }),
});

const LIST_METRIC_NAMES_INPUT = z.object({
  contains: optionalText.meta({
    description:
      "Case-insensitive substring the name must contain, such as 'memory' or 'http_request'. Omit to list everything, which on a busy fleet is thousands of names.",
  }),
});

const GET_METRIC_METADATA_INPUT = z.object({
  metric: z.string().trim().min(1, "must be a metric name").meta({
    description:
      "The exact metric name, as it appears in ListMetricNames or in a series you have already queried.",
  }),
});

const LIST_ALERT_RULES_INPUT = z.object({
  contains: optionalText.meta({
    description:
      "Case-insensitive substring the rule name must contain. Omit to list every rule.",
  }),
});

export const METRICS_TOOLS: Tool[] = [
  apiTool({
    name: "QueryMetrics",
    description:
      "Evaluate a PromQL expression against the connected metrics source at a single moment in time, which gives you one number rather than a series. Use it to read a value as it was when the alert fired, or as it is now. When you need to know how a value behaved over time, such as whether it climbed steadily or spiked, use QueryMetricsRange instead.",
    input: QUERY_METRICS_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "metric",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const source = resolveMetricsSource();
      if (!isSource(source)) return source;
      const { query } = input;
      try {
        return await withStoredCredential(
          source.id,
          async (): Promise<ToolExecuteResult> => {
            const data = await instantQuery(
              source.query,
              ctx.signal,
              query,
              input.at === "alert"
                ? alertAnchorFor(ctx.sessionId).toISOString()
                : undefined,
            );
            const result: MetricsQueryResult = capSeries(data);
            if (result.series.length === 0) {
              return {
                content: {
                  ...result,
                  note: withEmpty(result, query, source.label),
                },
              };
            }
            return { content: result };
          },
        );
      } catch (err) {
        return corrective(err);
      }
    },
  }),
  apiTool({
    name: "QueryMetricsRange",
    description:
      "Evaluate a PromQL expression against the connected metrics source across a window of time around the alert, or around now if no alert started this session. This is how you see the shape of a problem: whether a value rose gradually or jumped, and whether it recovered afterwards. Use rate() and aggregations to keep the number of returned series small, because only the first twenty are returned.",
    input: QUERY_METRICS_RANGE_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "metric",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const source = resolveMetricsSource();
      if (!isSource(source)) return source;
      const { query, stepSeconds } = input;

      const anchor = alertAnchorFor(ctx.sessionId);
      const lookbackMs = input.lookbackMinutes * 60_000;
      const lookforwardMs = input.lookforwardMinutes * 60_000;
      // Metrics after the alert are evidence too (did it recover?), but the
      // window never extends into the future.
      const end = new Date(
        Math.min(anchor.getTime() + lookforwardMs, Date.now()),
      );
      const start = new Date(anchor.getTime() - lookbackMs);
      const windowSeconds = Math.max(
        1,
        Math.round((end.getTime() - start.getTime()) / 1000),
      );
      // Capped at the window: a step wider than it returns one point, which
      // reads as a flat series rather than as a step chosen too coarsely.
      const step = Math.round(
        Math.min(
          stepSeconds ??
            Math.max(15, Math.ceil(windowSeconds / TARGET_POINTS_PER_SERIES)),
          windowSeconds,
        ),
      );

      try {
        return await withStoredCredential(
          source.id,
          async (): Promise<ToolExecuteResult> => {
            const data = await rangeQuery(
              source.query,
              ctx.signal,
              query,
              start.toISOString(),
              end.toISOString(),
              step,
            );
            const result: MetricsRangeResult = {
              ...capSeries(data),
              windowStart: start.toISOString(),
              windowEnd: end.toISOString(),
              stepSeconds: step,
            };
            if (result.series.length === 0) {
              return {
                content: {
                  ...result,
                  note: withEmpty(result, query, source.label),
                },
              };
            }
            return { content: result };
          },
        );
      } catch (err) {
        return corrective(err);
      }
    },
  }),

  apiTool({
    name: "ListMetricNames",
    description:
      "List the metric names this source is currently storing, narrowed by a substring. Call it before querying a metric you have not already seen in an alert label or an earlier result: a PromQL expression naming a metric that does not exist returns no series, which reads as 'the value is fine' rather than as a mistake. Returns names only, not values or labels.",
    input: LIST_METRIC_NAMES_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "text",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const source = resolveMetricsSource();
      if (!isSource(source)) return source;
      const contains = input.contains ?? null;
      try {
        return await withStoredCredential(
          source.id,
          async (): Promise<ToolExecuteResult> => {
            const end = new Date();
            const start = new Date(
              end.getTime() - NAME_WINDOW_MINUTES * 60_000,
            );
            const names = await metricNames(
              source.query,
              ctx.signal,
              contains,
              start.toISOString(),
              end.toISOString(),
            );
            const searched = `Names stored between ${start.toISOString()} and ${end.toISOString()} were searched. A metric last written before that window is not listed here, which is not the same as it never existing.`;
            if (names.length === 0) {
              return {
                content: `No metric names matched. ${searched} Widen the substring, or drop it to see what this source stores at all.`,
              };
            }
            const { items: shown, coverage } = fitList(names, {
              keep: "start",
              max: MAX_METRIC_NAMES,
              kept: "first",
              noun: "metric names",
              reach: "Narrow the substring to list the ones left out.",
            });
            const result: MetricNamesResult = {
              names: shown,
              ...(coverage && { coverage }),
              note: searched,
            };
            return { content: result };
          },
        );
      } catch (err) {
        return corrective(err);
      }
    },
  }),

  apiTool({
    name: "GetMetricMetadata",
    description:
      "Read what a metric measures and how: its type (counter, gauge, histogram, summary), its unit where the exporter declared one, and its help text. A counter only means something through rate() and a raw read of one is meaningless, so check the type before writing an expression against an unfamiliar metric. Not every source stores this, and the result says so when it does not.",
    input: GET_METRIC_METADATA_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "text",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const source = resolveMetricsSource();
      if (!isSource(source)) return source;
      const { metric } = input;
      /* Stating the condition rather than the limitation: on VictoriaMetrics an
         empty answer is a flag left off as readily as an undeclared metric. */
      if (!source.capabilities.metricMetadata) {
        return {
          content: `${source.label} may not serve metric metadata: it needs v1.130.0 or newer with -enableMetadata set, and answers empty for every metric otherwise. So nothing here can tell you the type or unit of "${metric.trim()}", and nothing here can tell you which of those two it is. This says nothing about whether the metric exists. Read its type from the exporter, or infer it from how the values behave over a range.`,
        };
      }
      try {
        return await withStoredCredential(
          source.id,
          async (): Promise<ToolExecuteResult> => {
            const meta = await metricMetadata(
              source.query,
              ctx.signal,
              metric.trim(),
            );
            if (meta === null) {
              return {
                content: `No exporter declared metadata for "${metric.trim()}" on ${source.label}. The metric may still exist and be queryable.`,
              };
            }
            return { content: meta };
          },
        );
      } catch (err) {
        return corrective(err);
      }
    },
  }),

  apiTool({
    name: "ListAlertRules",
    description:
      "List the alerting rules this source evaluates, each with the PromQL expression it tests and whether it is firing now. This is how you read the condition behind an alert rather than inferring it from the alert's labels: the expression names the metric, the threshold and the window that fired. Returns rule definitions and current state, not the history of when a rule fired.",
    input: LIST_ALERT_RULES_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "text",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const source = resolveMetricsSource();
      if (!isSource(source)) return source;
      // A source with no rules endpoint has told us nothing, not that it
      // evaluates none: VictoriaMetrics serves them from vmalert alone.
      if (source.rules === null) {
        return {
          content: `No rules endpoint is configured for ${source.label}, so nothing here can say which alerting rules it evaluates or whether any is firing. This is a gap in the connection, not an absence of rules. The user can add the rules URL on the Integrations page - on VictoriaMetrics it is vmalert's address, and on Grafana Cloud the Grafana stack's.`,
          isError: true,
        };
      }
      const endpoint = source.rules;
      const contains = input.contains ?? null;
      const needle = contains ? contains.toLowerCase() : null;
      try {
        return await withStoredCredential(
          source.id,
          async (): Promise<ToolExecuteResult> => {
            const rules = await alertingRules(endpoint, ctx.signal);
            const matched =
              needle === null
                ? rules
                : rules.filter((r) => r.name.toLowerCase().includes(needle));
            if (matched.length === 0) {
              return {
                content:
                  needle === null
                    ? `${source.label} returned no alerting rules. That is not proof it evaluates none: a VictoriaMetrics query endpoint answers this the same way, with an empty list, when the rules actually live in vmalert.`
                    : `No alerting rule name contains "${contains}".`,
              };
            }
            const { items: kept, coverage } = fitList(matched, {
              keep: "start",
              max: MAX_ALERT_RULES,
              kept: "first",
              noun: "alerting rules",
              reach: "Pass contains to narrow the rules to the one that fired.",
            });
            const result: AlertRulesResult = {
              rules: kept,
              ...(coverage && { coverage }),
            };
            return { content: result };
          },
        );
      } catch (err) {
        return corrective(err);
      }
    },
  }),
];
