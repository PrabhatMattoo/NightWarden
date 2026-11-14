import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RunnerRecord } from "@nightwarden/shared";
import { refusals, runnerRecordsSchema } from "@nightwarden/shared/schemas";
import { listRunnersMeta } from "../fleet/runners-store.js";
import { listRunners } from "../fleet/connections.js";
import { requireSession } from "../auth/session.js";
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
  app.get("/runners", { onRequest: requireSession, schema }, async () => {
    const live = listRunners();
    const byRunner = new Map<string, typeof live>();
    for (const r of live) {
      const list = byRunner.get(r.runnerId);
      if (list) list.push(r);
      else byRunner.set(r.runnerId, [r]);
    }

    const records: RunnerRecord[] = [];
    for (const t of await listRunnersMeta()) {
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
  });

  logger.info("runner routes registered");
}
