import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { runSession } from "./agent/loop/run-session.js";
import { registerApi } from "./api.js";
import { createDispatcher, type Dispatcher } from "./dispatcher.js";
import type { ModelFor } from "./llm/factory.js";

interface ServerOptions {
  // Where every run and model check gets its model; unset is the provider's own.
  modelFor?: ModelFor;
  logger?: FastifyServerOptions["logger"];
}

interface Server {
  server: FastifyInstance;
  dispatcher: Dispatcher;
}

// The dispatcher whose runs get their model from `modelFor`.
export function dispatcherFor(modelFor?: ModelFor): Dispatcher {
  return createDispatcher({
    run: (input) => runSession(input, modelFor),
  });
}

// Opens no database, so describing the API builds the same server boot does.
export async function buildServer(
  options: ServerOptions = {},
): Promise<Server> {
  const dispatcher = dispatcherFor(options.modelFor);
  const server = Fastify({
    logger: options.logger ?? false,
    trustProxy: true,
    // Long-lived frontend SSE streams would otherwise hold close() open forever.
    forceCloseConnections: true,
  });
  await registerApi(server, {
    dispatcher,
    ...(options.modelFor !== undefined && { modelFor: options.modelFor }),
  });
  // Outside /api: a container probe is infrastructure, not API surface.
  server.get("/health", async () => ({ status: "ok" }));
  return { server, dispatcher };
}
