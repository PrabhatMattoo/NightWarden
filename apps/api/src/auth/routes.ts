import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { SignInOptions } from "@nightwarden/shared";
import { refusals, signInOptionsSchema } from "@nightwarden/shared/schemas";
import { mailServer } from "../mail/store.js";
import { getAuth } from "./instance.js";
import { authHeaders } from "./session.js";

export async function registerAuthRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  /* Better Auth owns every path beneath /api/auth, which is its own default
     basePath, so sign-in, sign-out and change-password need no route of ours. */
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  fastify.route({
    method: ["GET", "POST"],
    url: "/auth/*",
    // Better Auth answers for itself, sign-in included, which needs no session.
    config: { permission: "public" },
    schema: { hide: true },
    async handler(request, reply) {
      const url = new URL(
        request.url,
        `${request.protocol}://${request.headers.host ?? "localhost"}`,
      );
      const response = await getAuth().handler(
        new Request(url, {
          method: request.method,
          headers: authHeaders(request),
          ...(request.body !== undefined &&
            request.body !== null && { body: JSON.stringify(request.body) }),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      return reply.send(response.body ? await response.text() : null);
    },
  });

  app.get(
    "/sign-in-options",
    {
      // Read before sign-in, to decide what the forgotten-password page offers.
      config: { permission: "public" },
      schema: { response: { 200: signInOptionsSchema, ...refusals() } },
    },
    (): SignInOptions => ({ passwordReset: mailServer() !== null }),
  );
}
