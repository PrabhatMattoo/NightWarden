import { fromNodeHeaders } from "better-auth/node";
import type { Actor } from "@nightwarden/shared";
import type { FastifyRequest } from "fastify";
import { CLIENT_IP_HEADER, getAuth } from "./instance.js";

// Fastify decides who the visitor is; `set` replaces any value the client sent.
export function authHeaders(request: FastifyRequest): Headers {
  const headers = fromNodeHeaders(request.headers);
  headers.set(CLIENT_IP_HEADER, request.ip);
  return headers;
}

type SessionPayload = ReturnType<typeof getAuth>["$Infer"]["Session"];

// The account with the role its member row gives it, null once it is no longer a member.
export type SignedInUser = SessionPayload["user"] & {
  role: SessionPayload["role"];
};

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
  return session === null ? null : { ...session.user, role: session.role };
}
