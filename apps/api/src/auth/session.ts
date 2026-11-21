import { fromNodeHeaders } from "better-auth/node";
import type { Actor } from "@nightwarden/shared";
import type { FastifyRequest } from "fastify";
import { getAuth } from "./instance.js";

export type SignedInUser = ReturnType<
  typeof getAuth
>["$Infer"]["Session"]["user"];

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
  return session?.user ?? null;
}
