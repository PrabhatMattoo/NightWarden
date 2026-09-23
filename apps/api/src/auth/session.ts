import { fromNodeHeaders } from "better-auth/node";
import type { Actor, ThemePreference } from "@nightwarden/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getAuth } from "./instance.js";

export interface SignedInUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  theme: ThemePreference;
}

// The audit-trail slice of a signed-in user: who released a write, without the
// role, which is not part of the record a decision carries.
export function actorOf(user: SignedInUser): Actor {
  return { id: user.id, name: user.name, email: user.email };
}

// Validated against the auth_session row rather than a signature alone, so a
// revoked device stops working the moment its row is deleted.
export async function currentUser(
  request: FastifyRequest,
): Promise<SignedInUser | null> {
  const session = await getAuth().api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (!session) return null;
  const { id, email, name, role, theme } = session.user;
  return {
    id,
    email,
    name,
    role: typeof role === "string" ? role : null,
    theme,
  };
}

export async function isAuthenticated(
  request: FastifyRequest,
): Promise<boolean> {
  return (await currentUser(request)) !== null;
}

// The preHandler every authenticated route already names, so replacing what
// backs it moved no call site.
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (await isAuthenticated(request)) return;
  await reply.code(401).send({ error: "authentication required" });
}
