import { probeSignal } from "../reachability.js";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { MetricsSourceStatus } from "@nightwarden/shared";
import {
  refusals,
  metricsConnectInputSchema,
  metricsErrorBodySchema,
  metricsSourceStatusSchema,
} from "@nightwarden/shared/schemas";
import { requireSession } from "../../auth/session.js";
import {
  deleteMetricsSource,
  metricsSourceRow,
  saveMetricsSource,
} from "./store.js";
import { logger } from "../../logger.js";
import { MetricsApiError, instantQuery, alertingRules } from "./client.js";
import {
  endpointFrom,
  getMetricsSource,
  secretFor,
  statusOf,
} from "./sources.js";
import { METRICS_PRESETS } from "./presets.js";
import { withStoredCredential } from "../credential-health.js";

async function statusPayload(): Promise<MetricsSourceStatus> {
  return statusOf(await metricsSourceRow());
}

// bad_query maps to 400 explicitly: a Prometheus-compatible source reports
// envelope errors with HTTP 200, which must not leak through as a success.
async function sendMetricsError(
  reply: FastifyReply,
  err: unknown,
): Promise<FastifyReply> {
  if (err instanceof MetricsApiError) {
    const status =
      err.code === "unauthorized" ? 422 : err.code === "bad_query" ? 400 : 502;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  throw err;
}

export async function registerMetricsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const metricsRefusals = refusals(metricsErrorBodySchema);
  const answersStatus = {
    response: { 200: metricsSourceStatusSchema, ...metricsRefusals },
  };

  // Status only - like every other integration, no credential rides a response.
  app.get(
    "/integrations/metrics",
    { onRequest: requireSession, schema: answersStatus },
    async () => await statusPayload(),
  );

  // Probed with the calls an investigation makes, so a rules URL answering
  // nothing is refused here rather than found by a run that cannot close.
  app.post(
    "/integrations/metrics",
    {
      onRequest: requireSession,
      schema: {
        body: metricsConnectInputSchema,
        response: { 201: metricsSourceStatusSchema, ...metricsRefusals },
      },
    },
    async (request, reply) => {
      const { kind, query, rules } = request.body;
      const name = METRICS_PRESETS[kind].label;
      // One source, whatever product: what you point at is already an
      // aggregate, so a second is a mistake; the same one reconnects in place.
      const connected = await getMetricsSource();
      if (connected !== null && connected.kind !== kind) {
        return reply.code(409).send({
          error: `${connected.label} is already connected. Disconnect it first.`,
        });
      }
      try {
        await instantQuery(
          endpointFrom(query, name, kind),
          probeSignal(),
          "up",
        );
        if (rules !== undefined) {
          await alertingRules(
            endpointFrom(rules, `${name} rules`, kind),
            probeSignal(),
          );
        }
        await saveMetricsSource({
          kind,
          label: name,
          queryUrl: query.url,
          queryAuthorization: secretFor(query, kind),
          queryOrgId: query.orgId ?? null,
          rulesUrl: rules?.url ?? null,
          rulesAuthorization:
            rules === undefined ? null : secretFor(rules, kind),
          rulesOrgId: rules?.orgId ?? null,
        });
        logger.info({ kind, url: query.url }, "metrics source connected");
        return await reply.code(201).send(await statusPayload());
      } catch (err) {
        return await sendMetricsError(reply, err);
      }
    },
  );

  app.post(
    "/integrations/metrics/test",
    { onRequest: requireSession, schema: answersStatus },
    async (_request, reply) => {
      const source = await getMetricsSource();
      if (source === null) {
        return reply
          .code(400)
          .send({ error: "No metrics source is connected" });
      }
      try {
        await withStoredCredential(source.id, async () => {
          await instantQuery(source.query, probeSignal(), "up");
          if (source.rules !== null) {
            await alertingRules(source.rules, probeSignal());
          }
        });
        return await statusPayload();
      } catch (err) {
        return await sendMetricsError(reply, err);
      }
    },
  );

  // No id, as Loki has none: there is one source to disconnect or none.
  app.delete(
    "/integrations/metrics",
    {
      onRequest: requireSession,
      schema: { response: { 204: z.undefined(), ...refusals() } },
    },
    async (_request, reply) => {
      await deleteMetricsSource();
      logger.info({}, "metrics source disconnected");
      return reply.code(204).send();
    },
  );
}
