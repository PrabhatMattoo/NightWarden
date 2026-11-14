import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuthStatusResponse } from "@nightwarden/shared";
import {
  authStatusResponseSchema,
  refusals,
} from "@nightwarden/shared/schemas";
import { getAuth } from "./instance.js";
import { ownerExists } from "./owner-store.js";
import { currentUser } from "./session.js";

export async function registerAuthRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  /* Better Auth owns every path beneath /api/auth, which is its own default
     basePath, so sign-in, sign-out and change-password need no route of ours. */
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  fastify.route({
    method: ["GET", "POST"],
    url: "/auth/*",
    schema: { hide: true },
    async handler(request, reply) {
      const url = new URL(
        request.url,
        `${request.protocol}://${request.headers.host ?? "localhost"}`,
      );
      const response = await getAuth().handler(
        new Request(url, {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
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

  // Hyphenated so it cannot be swallowed by the catch-all above.
  app.get(
    "/auth-status",
    {
      schema: {
        response: { 200: authStatusResponseSchema, ...refusals() },
      },
    },
    async (request): Promise<AuthStatusResponse> => {
      if (!(await ownerExists())) return { ownerExists: false };
      const user = await currentUser(request);
      if (!user) return { ownerExists: true, authenticated: false };
      return {
        ownerExists: true,
        authenticated: true,
        email: user.email,
        name: user.name,
        image: user.image,
        theme: user.theme,
      };
    },
  );
}
