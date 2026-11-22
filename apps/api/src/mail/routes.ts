import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  mailPatchSchema,
  mailSettingsSchema,
  refusals,
} from "@nightwarden/shared/schemas";
import { LockedSettingError } from "../config/env.js";
import { logger } from "../logger.js";
import {
  loadMailSettings,
  mailServerWith,
  updateMailSettings,
} from "./store.js";
import { MailServerError, verifyMailServer } from "./transport.js";

export async function registerMailRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/config/mail",
    {
      config: { permission: { mail: ["read"] } },
      schema: { response: { 200: mailSettingsSchema, ...refusals() } },
    },
    async () => loadMailSettings(),
  );

  // The server is checked before anything is stored, so a saved setting has connected once.
  app.put(
    "/config/mail",
    {
      config: { permission: { mail: ["manage"] } },
      schema: {
        body: mailPatchSchema,
        response: { 200: mailSettingsSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      try {
        const merged = mailServerWith(request.body);
        if (merged === null) {
          return reply.code(422).send({
            error: "A host, a port and a from address are needed to send mail.",
          });
        }
        await verifyMailServer(merged);
        const saved = updateMailSettings(request.body);
        logger.info({ host: merged.host }, "mail settings updated");
        return saved;
      } catch (err) {
        if (err instanceof MailServerError) {
          return reply.code(422).send({ error: err.message });
        }
        if (err instanceof LockedSettingError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
