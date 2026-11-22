import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  auditPageQuerySchema,
  auditPageSchema,
  refusals,
} from "@nightwarden/shared/schemas";
import { listAuditEvents } from "./audit-store.js";

export async function registerAuditRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/audit",
    {
      config: { permission: { audit: ["read"] } },
      schema: {
        querystring: auditPageQuerySchema,
        response: { 200: auditPageSchema, ...refusals() },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;
      return listAuditEvents(limit, offset);
    },
  );
}
