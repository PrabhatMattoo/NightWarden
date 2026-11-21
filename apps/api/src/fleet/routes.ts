import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RunnerRecord } from "@nightwarden/shared";
import {
  createdRunnerSchema,
  createRunnerRequestSchema,
  refusals,
  runnerRecordsSchema,
} from "@nightwarden/shared/schemas";
import {
  createRunner,
  deleteRunner,
  listRunnersMeta,
  ServerNameTakenError,
} from "./runners-store.js";
import { closeRunnerConnections, listRunners } from "./connections.js";
import { logger } from "../logger.js";

export async function registerRunnerRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Live runners come from the in-memory registry; offline tokens show as
  // single rows so their install command remains discoverable.
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const schema = {
    response: { 200: runnerRecordsSchema, ...refusals() },
  };
  app.get(
    "/runners",
    { config: { permission: { runner: ["read"] } }, schema },
    async () => {
      const live = listRunners();
      const byRunner = new Map<string, typeof live>();
      for (const r of live) {
        const list = byRunner.get(r.runnerId);
        if (list) list.push(r);
        else byRunner.set(r.runnerId, [r]);
      }

      const records: RunnerRecord[] = [];
      for (const t of listRunnersMeta()) {
        const runners = byRunner.get(t.id);
        if (!runners || runners.length === 0) {
          records.push({
            id: t.id,
            platform: t.platform,
            serverName: t.serverName,
            hostname: null,
            createdAt: t.createdAt,
            online: false,
            lastSeen: null,
            manifest: null,
          });
          continue;
        }
        for (const r of runners) {
          records.push({
            id: t.id,
            platform: t.platform,
            serverName: t.serverName,
            hostname: r.hostname,
            createdAt: t.createdAt,
            online: r.online,
            lastSeen: new Date(r.lastSeen).toISOString(),
            manifest: r.manifest,
          });
        }
      }
      return records;
    },
  );

  // Adding a runner issues the token it installs with: the plaintext comes back
  // here once, and only its hash is kept.
  app.post(
    "/runners",
    {
      config: { permission: { runner: ["manage"] } },
      schema: {
        body: createRunnerRequestSchema,
        response: { 201: createdRunnerSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      const { platform, serverName } = request.body;
      try {
        const created = createRunner(platform, serverName);
        return await reply.code(201).send({
          id: created.id,
          token: created.plaintext,
          platform: created.platform,
          serverName: created.serverName,
          createdAt: created.createdAt,
        });
      } catch (err) {
        if (!(err instanceof ServerNameTakenError)) throw err;
        return reply.code(409).send({ error: err.message });
      }
    },
  );

  // Its live sockets close at once, so removal never waits on a reconnect.
  app.delete(
    "/runners/:id",
    {
      config: { permission: { runner: ["manage"] } },
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.undefined(), ...refusals() },
      },
    },
    async (request, reply) => {
      if (!deleteRunner(request.params.id)) {
        return reply.code(404).send({ error: "runner not found" });
      }
      closeRunnerConnections(request.params.id);
      return reply.code(204).send();
    },
  );

  logger.info("runner routes registered");
}
