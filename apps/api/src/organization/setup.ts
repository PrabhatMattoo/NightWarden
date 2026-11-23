import { APIError } from "better-auth/api";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { SetupStatus } from "@nightwarden/shared";
import {
  refusals,
  setupRequestSchema,
  setupStatusSchema,
} from "@nightwarden/shared/schemas";
import { deleteUser } from "../auth/account-store.js";
import {
  AccountExistsError,
  createAccount,
  type NewAccount,
} from "../auth/accounts.js";
import { getAuth } from "../auth/instance.js";
import { authHeaders } from "../auth/session.js";
import {
  createOrganization,
  organizationExists,
} from "./organization-store.js";
import { claimSetupToken, writeSetupToken } from "./setup-token.js";

/* The install's first account and its organization, which the account administers.
   The account is made first because Better Auth's write cannot join a transaction. */
export async function createOwner(
  input: NewAccount & { organizationName: string },
): Promise<string> {
  const { organizationName, ...account } = input;
  const userId = await createAccount(account);
  try {
    createOrganization(organizationName, userId, {
      id: userId,
      name: account.name,
      email: account.email,
    });
  } catch (err) {
    // Without the organization the account would hold the email and block a retry.
    deleteUser(userId);
    throw err;
  }
  return userId;
}

export async function registerSetupRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/setup",
    {
      // Read before sign-in to decide which page to show.
      config: { permission: "public" },
      schema: { response: { 200: setupStatusSchema, ...refusals() } },
    },
    (): SetupStatus => ({ required: !organizationExists() }),
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
      const { token, ...owner } = request.body;
      if (organizationExists()) {
        return reply
          .code(409)
          .send({ error: "This install is already set up." });
      }
      if (!claimSetupToken(token)) {
        return reply.code(403).send({ error: "The setup token is not valid." });
      }
      try {
        await createOwner(owner);
      } catch (err) {
        writeSetupToken(token);
        if (err instanceof APIError || err instanceof AccountExistsError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      const signedIn = await getAuth().api.signInEmail({
        body: { email: owner.email, password: owner.password },
        headers: authHeaders(request),
        asResponse: true,
      });
      return reply
        .header("set-cookie", signedIn.headers.getSetCookie())
        .code(204)
        .send();
    },
  );
}
