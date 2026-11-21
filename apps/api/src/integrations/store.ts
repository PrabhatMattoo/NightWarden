import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { CredentialRejection } from "@nightwarden/shared";
import { getDb } from "../db.js";
import { readable } from "../route-schemas.js";
import { decrypt, encrypt } from "../secrets.js";
import { integrations } from "./schema.js";

/* One table holds every configured connection. This file owns the row shape;
   each kind's own accessors read the config it wrote. */

export interface IntegrationRow {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  // Plaintext, decrypted here so no caller has to.
  secrets: Record<string, string>;
  tokenHash: string | null;
  lastUsedAt: string | null;
  rejection: CredentialRejection | null;
  createdAt: string;
}

type RawRow = typeof integrations.$inferSelect;

const secretsJsonSchema = z.record(z.string(), z.string());

function decryptSecrets(encrypted: string | null): Record<string, string> {
  return encrypted === null
    ? {}
    : secretsJsonSchema.parse(JSON.parse(decrypt(encrypted)));
}

function toRow(raw: RawRow): IntegrationRow {
  return {
    id: raw.id,
    kind: raw.kind,
    name: raw.name,
    config: raw.config,
    secrets: decryptSecrets(raw.secrets),
    tokenHash: raw.tokenHash,
    lastUsedAt: raw.lastUsedAt,
    rejection:
      raw.rejectedAt === null
        ? null
        : { reason: raw.rejection ?? "", at: raw.rejectedAt },
    createdAt: raw.createdAt,
  };
}

/* A stored config that fails its kind's schema fails loudly, since reading it
   as valid would dial an address nobody connected. */
export function parseStoredConfig<T>(
  row: IntegrationRow,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(row.config);
  if (!parsed.success) {
    throw new Error(
      `Stored ${row.kind} integration config is invalid: ${readable(parsed.error)}`,
    );
  }
  return parsed.data;
}

function integrationsOfKind(kind: string): IntegrationRow[] {
  return getDb()
    .select()
    .from(integrations)
    .where(eq(integrations.kind, kind))
    .orderBy(asc(integrations.createdAt), asc(integrations.id))
    .all()
    .map(toRow);
}

// For a kind only one of can exist, which the route enforces.
export function integrationOfKind(kind: string): IntegrationRow | null {
  return integrationsOfKind(kind)[0] ?? null;
}

// Which kinds are connected, without decrypting any of them: the loop asks this
// every turn to notice an integration arriving or going away mid-run.
export function connectedKinds(): Set<string> {
  const rows = getDb()
    .selectDistinct({ kind: integrations.kind })
    .from(integrations)
    .all();
  return new Set(rows.map((r) => r.kind));
}

// Every row, for the unauthenticated token match and for name derivation.
export function allIntegrations(): IntegrationRow[] {
  return getDb()
    .select()
    .from(integrations)
    .orderBy(asc(integrations.createdAt), asc(integrations.id))
    .all()
    .map(toRow);
}

interface IntegrationInput {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
  tokenHash?: string | null;
  lastUsedAt?: string | null;
}

/* Saving means this configuration just proved itself, so a recorded refusal
   clears; created_at survives a reconfiguration. */
export function putIntegration(
  input: IntegrationInput,
  id: string = randomUUID(),
): string {
  const now = new Date().toISOString();
  const secrets = input.secrets ?? {};
  const values = {
    kind: input.kind,
    name: input.name,
    config: input.config,
    secrets:
      Object.keys(secrets).length === 0
        ? null
        : encrypt(JSON.stringify(secrets)),
    tokenHash: input.tokenHash ?? null,
    lastUsedAt: input.lastUsedAt ?? null,
    rejectedAt: null,
    rejection: null,
  };
  getDb()
    .insert(integrations)
    .values({ id, ...values, createdAt: now })
    .onConflictDoUpdate({ target: integrations.id, set: values })
    .run();
  return id;
}

export function deleteIntegrationById(id: string): boolean {
  return (
    getDb().delete(integrations).where(eq(integrations.id, id)).run().changes >
    0
  );
}

export function deleteIntegrationsOfKind(kind: string): void {
  getDb().delete(integrations).where(eq(integrations.kind, kind)).run();
}

export function markRejected(id: string, reason: string, at: string): void {
  getDb()
    .update(integrations)
    .set({ rejectedAt: at, rejection: reason })
    .where(eq(integrations.id, id))
    .run();
}

// Conditional, so a healthy call, which is nearly every call, writes nothing.
export function clearRejected(id: string): void {
  getDb()
    .update(integrations)
    .set({ rejectedAt: null, rejection: null })
    .where(and(eq(integrations.id, id), isNotNull(integrations.rejectedAt)))
    .run();
}

export function touchIntegration(id: string, at: string): void {
  getDb()
    .update(integrations)
    .set({ lastUsedAt: at })
    .where(eq(integrations.id, id))
    .run();
}

const GITHUB = "github";

const githubConfigSchema = z.object({
  repoOwner: z.string(),
  repoName: z.string(),
  tokenExpiresAt: z.string().nullable(),
});
type GitHubConfig = z.infer<typeof githubConfigSchema>;

interface GitHubIntegration {
  id: string;
  token: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
  rejection: CredentialRejection | null;
  createdAt: string;
}

export function getGitHubIntegration(): GitHubIntegration | null {
  const row = integrationOfKind(GITHUB);
  // GitHub always has a token: a row without one is malformed, treat as absent.
  const token = row?.secrets["token"];
  if (!row || token === undefined) return null;
  const config = parseStoredConfig(row, githubConfigSchema);
  return {
    id: row.id,
    token,
    repoOwner: config.repoOwner,
    repoName: config.repoName,
    tokenExpiresAt: config.tokenExpiresAt,
    rejection: row.rejection,
    createdAt: row.createdAt,
  };
}

export function saveGitHubIntegration(input: {
  token: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
}): void {
  const existing = integrationOfKind(GITHUB);
  putIntegration(
    {
      kind: GITHUB,
      name: "GitHub",
      config: {
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        tokenExpiresAt: input.tokenExpiresAt,
      } satisfies GitHubConfig,
      secrets: { token: input.token },
    },
    existing?.id,
  );
}

// Credential is untouched, only the binding moves; the caller has proved the token live.
export function updateGitHubIntegrationRepo(
  repoOwner: string,
  repoName: string,
): void {
  const existing = getGitHubIntegration();
  if (!existing) return;
  saveGitHubIntegration({
    token: existing.token,
    repoOwner,
    repoName,
    tokenExpiresAt: existing.tokenExpiresAt,
  });
}

export function deleteGitHubIntegration(): void {
  deleteIntegrationsOfKind(GITHUB);
}

const LOKI = "loki";

const lokiConfigSchema = z.object({
  baseUrl: z.string(),
  // Tenant for multi-tenant Loki (X-Scope-OrgID); null for single-binary Loki.
  orgId: z.string().nullable(),
});
type LokiConfig = z.infer<typeof lokiConfigSchema>;

interface LokiIntegration {
  id: string;
  baseUrl: string;
  orgId: string | null;
  authorization: string | null;
  rejection: CredentialRejection | null;
  createdAt: string;
}

export function getLokiIntegration(): LokiIntegration | null {
  const row = integrationOfKind(LOKI);
  if (!row) return null;
  const config = parseStoredConfig(row, lokiConfigSchema);
  return {
    id: row.id,
    baseUrl: config.baseUrl,
    orgId: config.orgId,
    authorization: row.secrets["authorization"] ?? null,
    rejection: row.rejection,
    createdAt: row.createdAt,
  };
}

export function saveLokiIntegration(input: {
  baseUrl: string;
  orgId: string | null;
  authorization: string | null;
}): void {
  const existing = integrationOfKind(LOKI);
  putIntegration(
    {
      kind: LOKI,
      name: "Grafana Loki",
      config: {
        baseUrl: input.baseUrl,
        orgId: input.orgId,
      } satisfies LokiConfig,
      ...(input.authorization !== null && {
        secrets: { authorization: input.authorization },
      }),
    },
    existing?.id,
  );
}

export function deleteLokiIntegration(): void {
  deleteIntegrationsOfKind(LOKI);
}

const SENTRY = "sentry";

const sentryConfigSchema = z.object({
  baseUrl: z.string(),
  // Every Sentry path is scoped by the organization, so this addresses rather
  // than filters, and a wrong one 404s every call.
  orgSlug: z.string(),
});
type SentryConfig = z.infer<typeof sentryConfigSchema>;

interface SentryIntegration {
  id: string;
  baseUrl: string;
  orgSlug: string;
  token: string;
  rejection: CredentialRejection | null;
  createdAt: string;
}

export function getSentryIntegration(): SentryIntegration | null {
  const row = integrationOfKind(SENTRY);
  // Sentry always has a token: a row without one is malformed, treat as absent.
  const token = row?.secrets["token"];
  if (!row || token === undefined) return null;
  const config = parseStoredConfig(row, sentryConfigSchema);
  return {
    id: row.id,
    baseUrl: config.baseUrl,
    orgSlug: config.orgSlug,
    token,
    rejection: row.rejection,
    createdAt: row.createdAt,
  };
}

export function saveSentryIntegration(input: {
  baseUrl: string;
  orgSlug: string;
  token: string;
}): void {
  const existing = integrationOfKind(SENTRY);
  putIntegration(
    {
      kind: SENTRY,
      name: "Sentry",
      config: {
        baseUrl: input.baseUrl,
        orgSlug: input.orgSlug,
      } satisfies SentryConfig,
      secrets: { token: input.token },
    },
    existing?.id,
  );
}

export function deleteSentryIntegration(): void {
  deleteIntegrationsOfKind(SENTRY);
}
