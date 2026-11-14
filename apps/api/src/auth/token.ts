import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { serverNameError } from "@nightwarden/shared";
import {
  refusals,
  mintedTokenSchema,
  mintTokenRequestSchema,
} from "@nightwarden/shared/schemas";
import { generateRunnerToken, deleteRunner } from "../fleet/runners-store.js";
import { closeRunnerConnections } from "../fleet/connections.js";
import { requireSession } from "./session.js";

export async function registerTokenRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Generate a new runner token. The plaintext nwr_... value is returned
  // exactly once here and never stored — the DB holds only the SHA-256 hash.
  app.post(
    "/tokens",
    {
      onRequest: requireSession,
      schema: {
        body: mintTokenRequestSchema,
        response: { 201: mintedTokenSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      // Platform is refused rather than defaulted: a guess throws away what the
      // frontend was told, and the row is what everything else reads.
      const { platform } = request.body;
      const nameError = serverNameError(request.body.serverName);
      if (nameError) return reply.code(400).send({ error: nameError });
      const serverName = request.body.serverName.trim();

      try {
        const generated = await generateRunnerToken(platform, serverName);
        return await reply.code(201).send({
          id: generated.id,
          token: generated.plaintext,
          platform: generated.platform,
          serverName: generated.serverName,
          createdAt: generated.createdAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE constraint failed: runner.server_name")) {
          return reply
            .code(409)
            .send({ error: "A runner with that server name already exists" });
        }
        throw err;
      }
    },
  );

  // Delete a runner token by id. Closes any live runner sockets authenticated
  // with it immediately so deletion cuts access without waiting for reconnect.
  app.delete(
    "/tokens/:id",
    {
      onRequest: requireSession,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.undefined(), ...refusals() },
      },
    },
    async (request, reply) => {
      const deleted = await deleteRunner(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: "token not found" });
      }
      closeRunnerConnections(request.params.id);
      return reply.code(204).send();
    },
  );
}
