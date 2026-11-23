import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAllowed, type Permission } from "@nightwarden/shared/permissions";
import { currentUser, type SignedInUser } from "./session.js";

declare module "fastify" {
  interface FastifyContextConfig {
    permission?: Permission | "public";
  }
  interface FastifyRequest {
    user: SignedInUser | null;
  }
}

async function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { permission } = request.routeOptions.config;
  if (permission === "public") return;
  const user = await currentUser(request);
  if (user === null) {
    return reply.code(401).send({ error: "authentication required" });
  }
  if (user.role === null) {
    return reply.code(403).send({
      error: "This account is no longer a member of the organization.",
      code: "not_a_member",
    });
  }
  if (permission === undefined || !isAllowed(user.role, permission)) {
    return reply.code(403).send({ error: "Your role does not allow this." });
  }
  request.user = user;
}

// One gate for every route registered after it: each names who may call it.
export function installAuthorization(api: FastifyInstance): void {
  api.decorateRequest("user", null);
  api.addHook("onRoute", (route) => {
    if (route.config?.permission === undefined) {
      throw new Error(
        `${String(route.method)} ${route.url} declares no permission`,
      );
    }
  });
  api.addHook("onRequest", authorizeRequest);
}

// A route behind the gate always has its user; only a public one could see null.
export function signedInUser(request: FastifyRequest): SignedInUser {
  if (request.user === null) {
    throw new Error("no signed-in user on an authenticated route");
  }
  return request.user;
}
