import { probeSignal } from "./reachability.js";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  deleteGitHubIntegration,
  getGitHubIntegration,
  saveGitHubIntegration,
  updateGitHubIntegrationRepo,
  deleteLokiIntegration,
  getLokiIntegration,
  saveLokiIntegration,
  deleteSentryIntegration,
  getSentryIntegration,
  saveSentryIntegration,
} from "./store.js";
import {
  deleteAlertSource,
  generateAlertSourceToken,
  getAlertSource,
} from "./alert-sources.js";
import { isAlertSourceKind } from "@nightwarden/shared";
import type { AlertSourceKind, AlertSourceStatus } from "@nightwarden/shared";
import type { Permission } from "@nightwarden/shared/permissions";
import {
  alertSourceCredentialSchema,
  alertSourceStatusSchema,
  refusals,
  gitHubErrorBodySchema,
  gitHubIntegrationStatusSchema,
  gitHubRepoPageSchema,
  lokiErrorBodySchema,
  lokiIntegrationStatusSchema,
  sandboxPreflightSchema,
  sentryErrorBodySchema,
  sentryIntegrationStatusSchema,
} from "@nightwarden/shared/schemas";
import {
  GitHubApiError,
  listRepos,
  ownerIsOrganization,
  validateRepoAccess,
} from "./github.js";
import {
  isCredentialRejection,
  withStoredCredential,
} from "./credential-health.js";
import { LokiApiError, probeLoki } from "./loki.js";
import { SentryApiError, probeSentry } from "./sentry.js";
import { preflight } from "../sandbox/preflight.js";
import { teardownAll } from "../sandbox/workspace.js";
import { logger } from "../logger.js";
import { publicUrl } from "../public-url.js";
import type {
  GitHubIntegrationStatus,
  LokiIntegrationStatus,
  SentryIntegrationStatus,
} from "@nightwarden/shared";

const ReposBodySchema = z
  .object({
    token: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
  })
  .default({});

const LokiConnectSchema = z.object({
  url: z.string().min(1),
  authHeader: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
});

const SentryConnectSchema = z.object({
  url: z.string().min(1),
  orgSlug: z.string().min(1),
  token: z.string().min(1),
});

const ConnectBodySchema = z.object({
  token: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

const RebindBodySchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

function statusPayload(): GitHubIntegrationStatus {
  const row = getGitHubIntegration();
  if (!row) {
    return {
      configured: false,
      repo: null,
      expiresAt: null,
      rejection: null,
    };
  }
  return {
    configured: true,
    repo: `${row.repoOwner}/${row.repoName}`,
    expiresAt: row.tokenExpiresAt,
    rejection: row.rejection,
  };
}

async function sendGitHubError(
  reply: FastifyReply,
  err: unknown,
): Promise<FastifyReply> {
  if (err instanceof GitHubApiError) {
    const status =
      err.code === "network"
        ? 502
        : isCredentialRejection(err)
          ? 422
          : err.status;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  throw err;
}

// GitHub 404s existence, visibility and permission alike, so for an organization
// the refusal links to its token approvals, a plausible cause.
async function sendRepoError(
  reply: FastifyReply,
  err: unknown,
  owner: string,
): Promise<FastifyReply> {
  if (err instanceof GitHubApiError && err.code === "repo_not_found") {
    const orgApprovalUrl = (await ownerIsOrganization(owner, probeSignal()))
      ? `https://github.com/organizations/${owner}/settings/personal-access-token-requests`
      : undefined;
    return reply.code(404).send({
      error: err.message,
      code: err.code,
      ...(orgApprovalUrl !== undefined && { orgApprovalUrl }),
    });
  }
  return await sendGitHubError(reply, err);
}

function lokiStatusPayload(): LokiIntegrationStatus {
  const row = getLokiIntegration();
  if (!row) {
    return {
      configured: false,
      url: null,
      hasAuth: false,
      hasOrgId: false,
      rejection: null,
    };
  }
  return {
    configured: true,
    url: row.baseUrl,
    hasAuth: row.authorization !== null,
    hasOrgId: row.orgId !== null,
    rejection: row.rejection,
  };
}

async function sendLokiError(
  reply: FastifyReply,
  err: unknown,
): Promise<FastifyReply> {
  if (err instanceof LokiApiError) {
    const status =
      err.code === "unauthorized" ? 422 : err.code === "bad_query" ? 400 : 502;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  throw err;
}

function sentryStatusPayload(): SentryIntegrationStatus {
  const row = getSentryIntegration();
  if (!row) {
    return {
      configured: false,
      url: null,
      orgSlug: null,
      rejection: null,
    };
  }
  return {
    configured: true,
    url: row.baseUrl,
    orgSlug: row.orgSlug,
    rejection: row.rejection,
  };
}

/* A refused credential answers 422 rather than the upstream 401, which the
   browser would read as its own session ending; a bad slug keeps its 404. */
async function sendSentryError(
  reply: FastifyReply,
  err: unknown,
): Promise<FastifyReply> {
  if (err instanceof SentryApiError) {
    const status =
      err.code === "network"
        ? 502
        : isCredentialRejection(err)
          ? 422
          : err.status;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  throw err;
}

export async function registerIntegrationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const gitHubRefusals = refusals(gitHubErrorBodySchema);
  const answersGitHub = {
    response: { 200: gitHubIntegrationStatusSchema, ...gitHubRefusals },
  };
  const refusalsOnly = {
    response: { 204: z.undefined(), ...refusals() },
  };

  // Status only: the plaintext token is never returned by any endpoint - there
  // is no reveal use case; regenerate on GitHub via the deep link instead.
  app.get(
    "/integrations/github",
    {
      config: { permission: { integration: ["read"] } },
      schema: answersGitHub,
    },
    async () => statusPayload(),
  );

  // Sandbox prerequisites, checked when the user clicks Connect: fail
  // loud at setup time, never at 3am mid-incident.
  app.post(
    "/integrations/github/preflight",
    {
      config: { permission: { integration: ["manage"] } },
      schema: {
        response: { 200: sandboxPreflightSchema, ...refusals() },
      },
    },
    async (request) => await preflight(request.log),
  );

  // During onboarding the token rides the body; afterwards the stored
  // credential is used. POST, never GET, so a token never lands in a URL.
  app.post(
    "/integrations/github/repos",
    {
      config: { permission: { integration: ["manage"] } },
      schema: {
        body: ReposBodySchema,
        response: { 200: gitHubRepoPageSchema, ...gitHubRefusals },
      },
    },
    async (request, reply) => {
      const stored = getGitHubIntegration();
      const page = request.body.page ?? 1;
      const token = request.body.token;
      const list = async (t: string) => await listRepos(t, probeSignal(), page);
      const fetchPage =
        token !== undefined
          ? async () => await list(token)
          : stored !== null
            ? async () =>
                await withStoredCredential(
                  stored.id,
                  async () => await list(stored.token),
                )
            : null;
      if (fetchPage === null) {
        return reply
          .code(400)
          .send({ error: "No token provided and no integration configured" });
      }
      try {
        const { repos, hasMore } = await fetchPage();
        return { repos, hasMore };
      } catch (err) {
        return await sendGitHubError(reply, err);
      }
    },
  );

  // Bind: validate the exact repo with the pasted token, then encrypt + store.
  app.post(
    "/integrations/github",
    {
      config: { permission: { integration: ["manage"] } },
      schema: {
        body: ConnectBodySchema,
        response: { 201: gitHubIntegrationStatusSchema, ...gitHubRefusals },
      },
    },
    async (request, reply) => {
      const { token, repo } = request.body;
      // The body schema regex guarantees exactly one slash with both sides
      // non-empty, so the two-element destructure cannot miss.
      const [owner, name] = repo.split("/") as [string, string];
      try {
        const validated = await validateRepoAccess(
          token,
          probeSignal(),
          owner,
          name,
        );
        saveGitHubIntegration({
          token,
          repoOwner: owner,
          repoName: name,
          tokenExpiresAt: validated.expiresAt,
        });
        logger.info({ repo }, "github integration configured");
        return await reply.code(201).send(statusPayload());
      } catch (err) {
        return await sendRepoError(reply, err, owner);
      }
    },
  );

  // Never accepts a token - only ever uses the one already stored, so the
  // request proves nothing beyond "pick a different repo".
  app.patch(
    "/integrations/github",
    {
      config: { permission: { integration: ["manage"] } },
      schema: { body: RebindBodySchema, ...answersGitHub },
    },
    async (request, reply) => {
      const stored = getGitHubIntegration();
      if (!stored) {
        return reply.code(400).send({ error: "GitHub is not connected" });
      }
      // The same regex as on connect, so the destructure cannot miss.
      const [owner, name] = request.body.repo.split("/") as [string, string];
      try {
        await withStoredCredential(
          stored.id,
          async () =>
            await validateRepoAccess(stored.token, probeSignal(), owner, name),
        );
        updateGitHubIntegrationRepo(owner, name);
        logger.info(
          { repo: request.body.repo },
          "github integration repository changed",
        );
        return await reply.code(200).send(statusPayload());
      } catch (err) {
        return await sendRepoError(reply, err, owner);
      }
    },
  );

  // Test connection: the stored token must still reach the bound repository.
  app.post(
    "/integrations/github/test",
    {
      config: { permission: { integration: ["manage"] } },
      schema: answersGitHub,
    },
    async (_request, reply) => {
      const stored = getGitHubIntegration();
      if (!stored) {
        return reply.code(400).send({ error: "GitHub is not connected" });
      }
      try {
        await withStoredCredential(
          stored.id,
          async () =>
            await validateRepoAccess(
              stored.token,
              probeSignal(),
              stored.repoOwner,
              stored.repoName,
            ),
        );
        return statusPayload();
      } catch (err) {
        return await sendGitHubError(reply, err);
      }
    },
  );

  // Deletes our stored copy only; full invalidation requires revoking on
  // GitHub. Sandboxes are torn down first, while the token still works.
  app.delete(
    "/integrations/github",
    {
      config: { permission: { integration: ["manage"] } },
      schema: refusalsOnly,
    },
    async (_request, reply) => {
      await teardownAll("disconnected");
      deleteGitHubIntegration();
      logger.info("github integration disconnected");
      return reply.code(204).send();
    },
  );

  const lokiRefusals = refusals(lokiErrorBodySchema);
  const answersLoki = {
    response: { 200: lokiIntegrationStatusSchema, ...lokiRefusals },
  };

  app.get(
    "/integrations/loki",
    { config: { permission: { integration: ["read"] } }, schema: answersLoki },
    async () => lokiStatusPayload(),
  );

  // Probed before saving, because it exercises auth and the tenant header: a
  // bad URL or credential fails at setup rather than at 3am.
  app.post(
    "/integrations/loki",
    {
      config: { permission: { integration: ["manage"] } },
      schema: {
        body: LokiConnectSchema,
        response: { 201: lokiIntegrationStatusSchema, ...lokiRefusals },
      },
    },
    async (request, reply) => {
      const { url, authHeader, orgId } = request.body;
      try {
        await probeLoki(url, authHeader ?? null, orgId ?? null, probeSignal());
        saveLokiIntegration({
          baseUrl: url,
          orgId: orgId ?? null,
          authorization: authHeader ?? null,
        });
        logger.info({ url }, "loki integration configured");
        return await reply.code(201).send(lokiStatusPayload());
      } catch (err) {
        return await sendLokiError(reply, err);
      }
    },
  );

  app.post(
    "/integrations/loki/test",
    {
      config: { permission: { integration: ["manage"] } },
      schema: answersLoki,
    },
    async (_request, reply) => {
      const stored = getLokiIntegration();
      if (!stored) {
        return reply.code(400).send({ error: "Loki is not connected" });
      }
      try {
        await withStoredCredential(
          stored.id,
          async () =>
            await probeLoki(
              stored.baseUrl,
              stored.authorization,
              stored.orgId,
              probeSignal(),
            ),
        );
        return lokiStatusPayload();
      } catch (err) {
        return await sendLokiError(reply, err);
      }
    },
  );

  app.delete(
    "/integrations/loki",
    {
      config: { permission: { integration: ["manage"] } },
      schema: refusalsOnly,
    },
    async (_request, reply) => {
      deleteLokiIntegration();
      logger.info("loki integration disconnected");
      return reply.code(204).send();
    },
  );

  const sentryRefusals = refusals(sentryErrorBodySchema);
  const answersSentry = {
    response: { 200: sentryIntegrationStatusSchema, ...sentryRefusals },
  };

  app.get(
    "/integrations/sentry",
    {
      config: { permission: { integration: ["read"] } },
      schema: answersSentry,
    },
    async () => sentryStatusPayload(),
  );

  // Probed on both scopes before saving: a token carrying only event:read would
  // otherwise connect cleanly and answer nothing about releases mid-incident.
  app.post(
    "/integrations/sentry",
    {
      config: { permission: { integration: ["manage"] } },
      schema: {
        body: SentryConnectSchema,
        response: { 201: sentryIntegrationStatusSchema, ...sentryRefusals },
      },
    },
    async (request, reply) => {
      const { url, orgSlug, token } = request.body;
      try {
        await probeSentry({ baseUrl: url, orgSlug, token }, probeSignal());
        saveSentryIntegration({ baseUrl: url, orgSlug, token });
        logger.info({ url, orgSlug }, "sentry integration configured");
        return await reply.code(201).send(sentryStatusPayload());
      } catch (err) {
        return await sendSentryError(reply, err);
      }
    },
  );

  app.post(
    "/integrations/sentry/test",
    {
      config: { permission: { integration: ["manage"] } },
      schema: answersSentry,
    },
    async (_request, reply) => {
      const stored = getSentryIntegration();
      if (!stored) {
        return reply.code(400).send({ error: "Sentry is not connected" });
      }
      try {
        await withStoredCredential(
          stored.id,
          async () => await probeSentry(stored, probeSignal()),
        );
        return sentryStatusPayload();
      } catch (err) {
        return await sendSentryError(reply, err);
      }
    },
  );

  app.delete(
    "/integrations/sentry",
    {
      config: { permission: { integration: ["manage"] } },
      schema: refusalsOnly,
    },
    async (_request, reply) => {
      deleteSentryIntegration();
      logger.info("sentry integration disconnected");
      return reply.code(204).send();
    },
  );

  // Credential issued here (the config plane); deliveries hit /alerts/ingest
  // (the data plane) with it. One family, so a new sender is a kind.
  const reads: Permission = { integration: ["read"] };
  const manages: Permission = { integration: ["manage"] };
  const readSender = {
    config: { permission: reads },
    preHandler: requireKnownAlertSource,
  };
  const manageSender = {
    config: { permission: manages },
    preHandler: requireKnownAlertSource,
  };
  // Any string, so a kind outside the shared list is a 404 naming nothing.
  const params = z.object({ kind: z.string() });

  app.get(
    "/integrations/alerting/:kind",
    {
      ...readSender,
      schema: {
        params,
        response: { 200: alertSourceStatusSchema, ...refusals() },
      },
    },
    async (request): Promise<AlertSourceStatus> => {
      const source = getAlertSource(senderOf(request.params));
      return {
        configured: source !== null,
        ingestUrl: `${publicUrl(request)}/api/alerts/ingest`,
        lastReceivedAt: source?.lastReceivedAt ?? null,
      };
    },
  );

  app.post(
    "/integrations/alerting/:kind/credential",
    {
      ...manageSender,
      schema: {
        params,
        response: { 201: alertSourceCredentialSchema, ...refusals() },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        token: generateAlertSourceToken(senderOf(request.params)),
      }),
  );

  // Deleting the row is the revoke: the credential stops matching on the next
  // delivery, which is the only place it is ever checked.
  app.delete(
    "/integrations/alerting/:kind",
    { ...manageSender, schema: { params, ...refusalsOnly } },
    async (request, reply) => {
      deleteAlertSource(senderOf(request.params));
      logger.info({ kind: request.params.kind }, "alert source disconnected");
      return reply.code(204).send();
    },
  );
}

function senderOf(params: { kind: string }): AlertSourceKind {
  // The route's preHandler has already refused an unknown kind.
  if (!isAlertSourceKind(params.kind)) {
    throw new Error(`Unknown alert source: ${params.kind}`);
  }
  return params.kind;
}

// Checked against the shared list, so the frontend and the API cannot disagree
// about which senders exist.
async function requireKnownAlertSource(
  request: FastifyRequest<{ Params: { kind: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { kind } = request.params;
  if (!isAlertSourceKind(kind)) {
    await reply.code(404).send({ error: `Unknown alert source: ${kind}` });
  }
}
