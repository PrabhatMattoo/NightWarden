import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { InvitationPreview } from "@nightwarden/shared";
import {
  acceptInvitationRequestSchema,
  invitationPreviewSchema,
  refusals,
} from "@nightwarden/shared/schemas";
import { deleteUser, userIdByEmail } from "../auth/account-store.js";
import { createAccount } from "../auth/accounts.js";
import { getAuth } from "../auth/instance.js";
import { authHeaders, currentUser } from "../auth/session.js";
import {
  acceptInvitation,
  findPendingInvitationByToken,
  InvitationNotValidError,
} from "./organization-store.js";

const params = z.object({ token: z.string() });

const NOT_VALID = "This invitation is not valid.";

export async function registerInvitationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/invitations/:token",
    {
      // The token is a random secret mailed to its one recipient.
      config: { permission: "public" },
      schema: {
        params,
        response: { 200: invitationPreviewSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      const found = findPendingInvitationByToken(request.params.token);
      if (found === undefined) {
        return reply.code(404).send({ error: NOT_VALID });
      }
      const preview: InvitationPreview = {
        email: found.email,
        organizationName: found.organizationName,
        role: found.role,
        inviterName: found.inviterName,
        accountExists: userIdByEmail(found.email) !== undefined,
        expired: found.expired,
      };
      return preview;
    },
  );

  app.post(
    "/invitations/:token/accept",
    {
      // The token is its own credential, and an existing account must also be signed in as the invited address.
      config: { permission: "public" },
      schema: {
        params,
        body: acceptInvitationRequestSchema,
        response: { 204: z.undefined(), ...refusals() },
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      const found = findPendingInvitationByToken(token);
      if (found === undefined) {
        return reply.code(404).send({ error: NOT_VALID });
      }
      if (found.expired) {
        return reply.code(410).send({
          error: "This invitation has expired. Ask an admin to send a new one.",
        });
      }
      const { email } = found;
      const accountId = userIdByEmail(email);
      if (accountId !== undefined) {
        // Signing in is the sign-in page's, MFA and throttle included; this only joins.
        const signedIn = await currentUser(request);
        if (signedIn === null) {
          return reply
            .code(401)
            .send({ error: `Sign in as ${email} to accept.` });
        }
        if (signedIn.id !== accountId) {
          return reply
            .code(403)
            .send({ error: `This invitation is for ${email}.` });
        }
        try {
          acceptInvitation(found.id, accountId);
        } catch (err) {
          if (err instanceof InvitationNotValidError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
        return reply.code(204).send();
      }
      const { name, password } = request.body;
      if (name === undefined || password === undefined) {
        return reply.code(400).send({
          error: "A name and a password are needed to create the account.",
        });
      }
      const created = await createAccount({ name, email, password });
      try {
        // A new account has no MFA yet, so its password alone signs it in.
        const { headers: signedIn, response } = await getAuth().api.signInEmail(
          {
            body: { email, password },
            headers: authHeaders(request),
            returnHeaders: true,
          },
        );
        acceptInvitation(found.id, response.user.id);
        return reply
          .header("set-cookie", signedIn.getSetCookie())
          .code(204)
          .send();
      } catch (err) {
        // The account was made for this invitation and goes with it, so the link works for a retry.
        deleteUser(created);
        if (err instanceof InvitationNotValidError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
