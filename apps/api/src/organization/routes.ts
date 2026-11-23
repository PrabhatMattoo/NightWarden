import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  invitationListSchema,
  inviteRequestSchema,
  memberListSchema,
  memberRolePatchSchema,
  organizationPatchSchema,
  organizationSchema,
  refusals,
  teamCreatedSchema,
  teamListSchema,
  teamMemberRequestSchema,
  teamRequestSchema,
} from "@nightwarden/shared/schemas";
import { signedInUser } from "../auth/authorize.js";
import { actorOf } from "../auth/session.js";
import { logger } from "../logger.js";
import { invitationMessage } from "../mail/messages.js";
import { mailServer } from "../mail/store.js";
import { MailServerError, sendMail } from "../mail/transport.js";
import { publicUrl } from "../public-url.js";
import {
  addTeamMember,
  cancelInvitation,
  createInvitation,
  createTeam,
  DefaultTeamError,
  deleteTeam,
  isMemberEmail,
  LastAdminError,
  listMembers,
  listPendingInvitations,
  listTeams,
  NotFoundError,
  readOrganization,
  removeMember,
  removeTeamMember,
  renameTeam,
  updateMemberRole,
  updateOrganization,
} from "./organization-store.js";

const idParams = z.object({ id: z.string() });
const teamMemberParams = z.object({ id: z.string(), userId: z.string() });
const noContent = { 204: z.undefined(), ...refusals() };

// What a store refuses by name answers with its own words; anything else is a bug and stays a 500.
function refused(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: err.message });
  }
  if (err instanceof LastAdminError || err instanceof DefaultTeamError) {
    return reply.code(409).send({ error: err.message });
  }
  throw err;
}

export async function registerOrganizationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Every person in the install sees the name, so it is not an admin's alone.
  app.get(
    "/organization",
    {
      config: { permission: { session: ["read"] } },
      schema: { response: { 200: organizationSchema, ...refusals() } },
    },
    async (_request, reply) => {
      const organization = readOrganization();
      if (organization === undefined) {
        return reply.code(404).send({ error: "unknown organization" });
      }
      return organization;
    },
  );

  app.patch(
    "/organization",
    {
      config: { permission: { organization: ["update"] } },
      schema: {
        body: organizationPatchSchema,
        response: { 200: organizationSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      try {
        return updateOrganization(request.body, actorOf(signedInUser(request)));
      } catch (err) {
        return refused(reply, err);
      }
    },
  );

  app.get(
    "/organization/members",
    {
      config: { permission: { member: ["read"] } },
      schema: { response: { 200: memberListSchema, ...refusals() } },
    },
    () => listMembers(),
  );

  app.patch(
    "/organization/members/:id",
    {
      config: { permission: { member: ["manage"] } },
      schema: {
        params: idParams,
        body: memberRolePatchSchema,
        response: noContent,
      },
    },
    async (request, reply) => {
      try {
        updateMemberRole(
          request.params.id,
          request.body.role,
          actorOf(signedInUser(request)),
        );
      } catch (err) {
        return refused(reply, err);
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    "/organization/members/:id",
    {
      config: { permission: { member: ["manage"] } },
      schema: { params: idParams, response: noContent },
    },
    async (request, reply) => {
      try {
        removeMember(request.params.id, actorOf(signedInUser(request)));
      } catch (err) {
        return refused(reply, err);
      }
      return reply.code(204).send();
    },
  );

  app.get(
    "/organization/invitations",
    {
      config: { permission: { invitation: ["manage"] } },
      schema: { response: { 200: invitationListSchema, ...refusals() } },
    },
    () => listPendingInvitations(),
  );

  app.post(
    "/organization/invitations",
    {
      config: { permission: { invitation: ["manage"] } },
      schema: { body: inviteRequestSchema, response: noContent },
    },
    async (request, reply) => {
      const { email, role, teamIds } = request.body;
      if (mailServer() === null) {
        return reply.code(409).send({
          error: "Set up a mail server under Settings, Mail before inviting.",
        });
      }
      if (isMemberEmail(email)) {
        return reply
          .code(409)
          .send({ error: "This person is already a member." });
      }
      const user = signedInUser(request);
      const actor = actorOf(user);
      let invited: ReturnType<typeof createInvitation>;
      try {
        invited = createInvitation(
          { email, role, teamIds: teamIds ?? [] },
          actor,
        );
      } catch (err) {
        return refused(reply, err);
      }
      try {
        await sendMail(
          invitationMessage(
            email,
            user.name,
            invited.organizationName,
            `${publicUrl(request)}/invite/${invited.token}`,
          ),
        );
      } catch (err) {
        // Canceled so no invitation sits pending for an email nobody received.
        try {
          cancelInvitation(invited.id, actor);
        } catch (cancelErr) {
          logger.error(
            { err: cancelErr },
            "undelivered invitation not canceled",
          );
        }
        if (err instanceof MailServerError) {
          return reply.code(502).send({
            error: `The invitation email could not be sent. ${err.message}`,
          });
        }
        throw err;
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    "/organization/invitations/:id",
    {
      config: { permission: { invitation: ["manage"] } },
      schema: { params: idParams, response: noContent },
    },
    async (request, reply) => {
      try {
        cancelInvitation(request.params.id, actorOf(signedInUser(request)));
      } catch (err) {
        return refused(reply, err);
      }
      return reply.code(204).send();
    },
  );

  app.get(
    "/organization/teams",
    {
      config: { permission: { team: ["manage"] } },
      schema: { response: { 200: teamListSchema, ...refusals() } },
    },
    () => listTeams(),
  );

  app.post(
    "/organization/teams",
    {
      config: { permission: { team: ["manage"] } },
      schema: {
        body: teamRequestSchema,
        response: { 200: teamCreatedSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      try {
        return createTeam(request.body.name, actorOf(signedInUser(request)));
      } catch (err) {
        return refused(reply, err);
      }
    },
  );

  app.patch(
    "/organization/teams/:id",
    {
      config: { permission: { team: ["manage"] } },
      schema: {
        params: idParams,
        body: teamRequestSchema,
        response: noContent,
      },
    },
    async (request, reply) => {
      try {
        renameTeam(
          request.params.id,
          request.body.name,
          actorOf(signedInUser(request)),
        );
      } catch (err) {
        return refused(reply, err);
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    "/organization/teams/:id",
    {
      config: { permission: { team: ["manage"] } },
      schema: { params: idParams, response: noContent },
    },
    async (request, reply) => {
      try {
        deleteTeam(request.params.id, actorOf(signedInUser(request)));
      } catch (err) {
        return refused(reply, err);
      }
      return reply.code(204).send();
    },
  );

  app.post(
    "/organization/teams/:id/members",
    {
      config: { permission: { team: ["manage"] } },
      schema: {
        params: idParams,
        body: teamMemberRequestSchema,
        response: noContent,
      },
    },
    async (request, reply) => {
      try {
        addTeamMember(
          request.params.id,
          request.body.userId,
          actorOf(signedInUser(request)),
        );
      } catch (err) {
        return refused(reply, err);
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    "/organization/teams/:id/members/:userId",
    {
      config: { permission: { team: ["manage"] } },
      schema: { params: teamMemberParams, response: noContent },
    },
    async (request, reply) => {
      try {
        removeTeamMember(
          request.params.id,
          request.params.userId,
          actorOf(signedInUser(request)),
        );
      } catch (err) {
        return refused(reply, err);
      }
      return reply.code(204).send();
    },
  );
}
