import { z } from "zod";
import { isMetricsSourceKind } from "@nightwarden/shared";
import type {
  CredentialRejection,
  MetricsSourceKind,
} from "@nightwarden/shared";
import {
  allIntegrations,
  deleteIntegrationById,
  parseStoredConfig,
  putIntegration,
  type IntegrationRow,
} from "../store.js";

/* A metrics source is a connection like any other; only its config shape is
   its own. Two endpoints and two credentials fit because `secrets` is a map. */

export interface MetricsSourceRow {
  id: string;
  kind: MetricsSourceKind;
  label: string;
  queryUrl: string;
  queryAuthorization: string | null;
  queryOrgId: string | null;
  rulesUrl: string | null;
  rulesAuthorization: string | null;
  rulesOrgId: string | null;
  rejection: CredentialRejection | null;
  createdAt: string;
}

const endpointSchema = z.object({
  url: z.string(),
  orgId: z.string().nullable(),
});

const metricsConfigSchema = z.object({
  query: endpointSchema,
  rules: endpointSchema.nullable(),
});
type MetricsConfig = z.infer<typeof metricsConfigSchema>;

function toSource(
  row: IntegrationRow,
  kind: MetricsSourceKind,
): MetricsSourceRow {
  const config = parseStoredConfig(row, metricsConfigSchema);
  return {
    id: row.id,
    kind,
    label: row.name,
    queryUrl: config.query.url,
    queryAuthorization: row.secrets["query"] ?? null,
    queryOrgId: config.query.orgId,
    rulesUrl: config.rules?.url ?? null,
    rulesAuthorization: row.secrets["rules"] ?? null,
    rulesOrgId: config.rules?.orgId ?? null,
    rejection: row.rejection,
    createdAt: row.createdAt,
  };
}

/* One source whatever the product, so this filters the set of five kinds rather
   than reading one fixed kind. The connect route refuses a second. */
export function metricsSourceRow(): MetricsSourceRow | null {
  for (const row of allIntegrations()) {
    if (isMetricsSourceKind(row.kind)) return toSource(row, row.kind);
  }
  return null;
}

export interface MetricsSourceInput {
  kind: MetricsSourceKind;
  label: string;
  queryUrl: string;
  queryAuthorization: string | null;
  queryOrgId: string | null;
  rulesUrl: string | null;
  rulesAuthorization: string | null;
  rulesOrgId: string | null;
}

export function saveMetricsSource(input: MetricsSourceInput): void {
  const secrets: Record<string, string> = {};
  if (input.queryAuthorization !== null) {
    secrets["query"] = input.queryAuthorization;
  }
  if (input.rulesAuthorization !== null) {
    secrets["rules"] = input.rulesAuthorization;
  }
  putIntegration(
    {
      kind: input.kind,
      name: input.label,
      config: {
        query: { url: input.queryUrl, orgId: input.queryOrgId },
        rules:
          input.rulesUrl === null
            ? null
            : { url: input.rulesUrl, orgId: input.rulesOrgId },
      } satisfies MetricsConfig,
      secrets,
    },
    // Reconnecting replaces in place, as Loki does, so the row keeps its id.
    metricsSourceRow()?.id,
  );
}

export function deleteMetricsSource(): void {
  const row = metricsSourceRow();
  if (row !== null) deleteIntegrationById(row.id);
}
