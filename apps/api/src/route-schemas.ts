import { APIError } from "better-auth/api";
import type { FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

/* Zod's own message is the issues array as JSON, which a route would send to a
   user verbatim. This names the field and says what is wrong with it. */
export function readable(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

/* Every route parses its request and encodes its reply through its own Zod
   schemas, so a field a response schema leaves out never leaves the process. */
export function installRouteSchemas(api: FastifyInstance): void {
  api.setValidatorCompiler(validatorCompiler);
  api.setSerializerCompiler(serializerCompiler);

  // One shape for every 400 a malformed request earns, so no route invents its own.
  api.setErrorHandler((error, _request, reply) => {
    // Better Auth's refusal, thrown by an in-process call, keeps its own status and sentence.
    if (error instanceof APIError) {
      // Carries Retry-After when a sign-in is throttled.
      new Headers(error.headers).forEach((value, key) => {
        reply.header(key, value);
      });
      return reply
        .code(error.statusCode)
        .send({ error: error.message || "The request was refused." });
    }
    if (!hasZodFastifySchemaValidationErrors(error)) throw error;
    const issues = error.validation.map((issue) => ({
      path: issue.instancePath.split("/").filter((part) => part !== ""),
      message: issue.message ?? "is invalid",
    }));
    return reply.code(400).send({ error: readable({ issues }) });
  });
}
