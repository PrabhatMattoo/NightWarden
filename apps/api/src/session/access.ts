import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { signedInUser } from "../auth/authorize.js";
import { isAllowed } from "../auth/permissions.js";
import { getSessionOwnership, type SessionOwnership } from "./store.js";

const idParams = z.object({ id: z.string() });

// A chat is its creator's alone, whatever the role; an investigation is shared.
function isVisibleTo(session: SessionOwnership, userId: string): boolean {
  return session.investigation || session.createdBy === userId;
}

export function canSeeSession(userId: string, sessionId: string): boolean {
  const session = getSessionOwnership(sessionId);
  return session !== undefined && isVisibleTo(session, userId);
}

/* Guards every route in its scope that takes a session id, so a new one cannot
   skip it. Someone else's chat answers exactly as an unknown id does. */
export async function requireSessionAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = idParams.safeParse(request.params);
  if (!params.success) return;
  const user = signedInUser(request);
  const session = getSessionOwnership(params.data.id);
  if (session === undefined || !isVisibleTo(session, user.id)) {
    return reply.code(404).send({ error: "unknown session" });
  }
  // The route's own permission lets a member delete their chat; erasing an
  // investigation's shared record takes the delete permission.
  if (
    request.method === "DELETE" &&
    session.investigation &&
    !isAllowed(user.role, { session: ["delete"] })
  ) {
    return reply.code(403).send({ error: "Your role does not allow this." });
  }
}
