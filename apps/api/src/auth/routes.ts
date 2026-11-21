import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { SetupStatus } from "@nightwarden/shared";
import {
  refusals,
  setupRequestSchema,
  setupStatusSchema,
} from "@nightwarden/shared/schemas";
import { getAuth } from "./instance.js";
import { ownerExists } from "./owner-store.js";
import { ADMIN_ROLE } from "./permissions.js";
import { claimSetupToken, writeSetupToken } from "./setup-token.js";

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

  app.get(
    "/setup",
    {
      // Read before sign-in to decide which page to show.
      config: { permission: "public" },
      schema: { response: { 200: setupStatusSchema, ...refusals() } },
    },
    (): SetupStatus => ({ required: !ownerExists() }),
  );

  app.post(
    "/setup",
    {
      // The setup token is its own credential.
      config: { permission: "public" },
      schema: {
        body: setupRequestSchema,
        response: { 204: z.undefined(), ...refusals() },
      },
    },
    async (request, reply) => {
      const { token, name, email, password } = request.body;
      if (ownerExists()) {
        return reply
          .code(409)
          .send({ error: "This install is already set up." });
      }
      if (!claimSetupToken(token)) {
        return reply.code(403).send({ error: "The setup token is not valid." });
      }
      const auth = getAuth();
      try {
        // Without headers: Better Auth reads a call that carries none as the server's own.
        await auth.api.createUser({
          body: { email, password, name, role: ADMIN_ROLE },
        });
      } catch (err) {
        writeSetupToken(token);
        if (err instanceof APIError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      const signedIn = await auth.api.signInEmail({
        body: { email, password },
        headers: fromNodeHeaders(request.headers),
        asResponse: true,
      });
      return reply
        .header("set-cookie", signedIn.headers.getSetCookie())
        .code(204)
        .send();
    },
  );
}
