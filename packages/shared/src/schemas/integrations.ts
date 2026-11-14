// What the integration routes answer. A status says what is configured, never a
// credential's value, and each product's refusals carry its own codes.
import { z } from "zod";
import { METRICS_SOURCE_KINDS } from "../metrics.js";

// A third party refused the stored credential; cleared by the next call it accepts.
const credentialRejectionSchema = z.object({
  reason: z.string(),
  at: z.string(),
});
export type CredentialRejection = z.infer<typeof credentialRejectionSchema>;

// One alert sender's credential and its delivery proof, never its configuration alone.
export const alertSourceStatusSchema = z.object({
  configured: z.boolean(),
  ingestUrl: z.string(),
  // Null until that sender actually posts, and again after a rotation.
  lastReceivedAt: z.string().nullable(),
});
export type AlertSourceStatus = z.infer<typeof alertSourceStatusSchema>;

export const alertSourceCredentialSchema = z.object({ token: z.string() });

// `bad_response` is a payload we cannot read, which no retry or credential fixes.
const gitHubErrorCodeSchema = z.enum([
  "invalid_token",
  "sso_required",
  "repo_not_found",
  "network",
  "bad_response",
]);
export type GitHubErrorCode = z.infer<typeof gitHubErrorCodeSchema>;

export const gitHubIntegrationStatusSchema = z.object({
  configured: z.boolean(),
  repo: z.string().nullable(),
  expiresAt: z.string().nullable(),
  rejection: credentialRejectionSchema.nullable(),
});
export type GitHubIntegrationStatus = z.infer<
  typeof gitHubIntegrationStatusSchema
>;

const gitHubRepoSummarySchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  pushedAt: z.string().nullable(),
  ownerIsOrg: z.boolean(),
});
export type GitHubRepoSummary = z.infer<typeof gitHubRepoSummarySchema>;

export const gitHubRepoPageSchema = z.object({
  repos: z.array(gitHubRepoSummarySchema),
  hasMore: z.boolean(),
});
export type GitHubRepoPage = z.infer<typeof gitHubRepoPageSchema>;

// `code` is absent on a refusal that never reached GitHub. `orgApprovalUrl` links
// to an organization's token approvals, a plausible cause of repo_not_found.
export const gitHubErrorBodySchema = z.object({
  error: z.string(),
  code: gitHubErrorCodeSchema.optional(),
  orgApprovalUrl: z.string().optional(),
});
export type GitHubErrorBody = z.infer<typeof gitHubErrorBodySchema>;

// The API host's own sandbox check, and the isolation its sandboxes will use.
export const sandboxPreflightSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  isolation: z.enum(["gvisor", "standard"]).optional(),
});
export type SandboxPreflight = z.infer<typeof sandboxPreflightSchema>;

const lokiErrorCodeSchema = z.enum([
  "network",
  "unauthorized",
  "bad_query",
  "bad_response",
]);
export type LokiErrorCode = z.infer<typeof lokiErrorCodeSchema>;

export const lokiErrorBodySchema = z.object({
  error: z.string(),
  code: lokiErrorCodeSchema.optional(),
});

export const lokiIntegrationStatusSchema = z.object({
  configured: z.boolean(),
  url: z.string().nullable(),
  // Whether an Authorization header is stored; the value itself never leaves the API.
  hasAuth: z.boolean(),
  // Whether a multi-tenant X-Scope-OrgID tenant is stored.
  hasOrgId: z.boolean(),
  rejection: credentialRejectionSchema.nullable(),
});
export type LokiIntegrationStatus = z.infer<typeof lokiIntegrationStatusSchema>;

/* Separate from `unauthorized` because Sentry answers 403 for a live token
   missing a scope, which the user fixes on the token rather than by replacing it. */
const sentryErrorCodeSchema = z.enum([
  "network",
  "unauthorized",
  "forbidden",
  "not_found",
  "bad_response",
]);
export type SentryErrorCode = z.infer<typeof sentryErrorCodeSchema>;

export const sentryErrorBodySchema = z.object({
  error: z.string(),
  code: sentryErrorCodeSchema.optional(),
});

export const sentryIntegrationStatusSchema = z.object({
  configured: z.boolean(),
  url: z.string().nullable(),
  // The organization slug every Sentry path is scoped by; not a secret.
  orgSlug: z.string().nullable(),
  rejection: credentialRejectionSchema.nullable(),
});
export type SentryIntegrationStatus = z.infer<
  typeof sentryIntegrationStatusSchema
>;

const metricsSourceKindSchema = z.enum(METRICS_SOURCE_KINDS, {
  error: "unknown metrics source",
});

/* An Authorization value and a tenant, the shape Loki already uses. The four
   AMP fields sign each request with SigV4 instead, and apply only to "amp". */
const metricsEndpointInputSchema = z.object({
  url: z.string().min(1),
  authHeader: z.string().min(1).optional(),
  basicUsername: z.string().min(1).optional(),
  basicPassword: z.string().min(1).optional(),
  // Sent as X-Scope-OrgID, which Mimir requires whenever multi-tenancy is on.
  orgId: z.string().min(1).optional(),
  accessKeyId: z.string().min(1).optional(),
  secretAccessKey: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  sessionToken: z.string().min(1).optional(),
});
export type MetricsEndpointInput = z.infer<typeof metricsEndpointInputSchema>;

// Without `rules` an investigation can never confirm the alert cleared, which is
// a stated limitation rather than an error.
export const metricsConnectInputSchema = z.object({
  kind: metricsSourceKindSchema,
  query: metricsEndpointInputSchema,
  rules: metricsEndpointInputSchema.optional(),
});
export type MetricsConnectInput = z.infer<typeof metricsConnectInputSchema>;

const metricsEndpointStatusSchema = z.object({
  url: z.string(),
  hasAuth: z.boolean(),
  hasOrgId: z.boolean(),
});
export type MetricsEndpointStatus = z.infer<typeof metricsEndpointStatusSchema>;

// One source or none, so every field but `configured` is null when there is none.
// `rules` is null when no rules endpoint is configured.
export const metricsSourceStatusSchema = z.object({
  configured: z.boolean(),
  kind: metricsSourceKindSchema.nullable(),
  label: z.string().nullable(),
  query: metricsEndpointStatusSchema.nullable(),
  rules: metricsEndpointStatusSchema.nullable(),
  rejection: credentialRejectionSchema.nullable(),
});
export type MetricsSourceStatus = z.infer<typeof metricsSourceStatusSchema>;

const metricsErrorCodeSchema = z.enum([
  "network",
  "unauthorized",
  "bad_query",
  "bad_response",
]);
export type MetricsErrorCode = z.infer<typeof metricsErrorCodeSchema>;

export const metricsErrorBodySchema = z.object({
  error: z.string(),
  code: metricsErrorCodeSchema.optional(),
});
