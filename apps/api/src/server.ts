import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { runSession } from "./agent/loop/run-session.js";
import { registerApi } from "./api.js";
import { createDispatcher, type Dispatcher } from "./dispatcher.js";

export interface ServerOptions {
  // Every request to the model provider goes through it; unset is the global fetch.
  providerFetch?: typeof fetch;
  logger?: FastifyServerOptions["logger"];
}

export interface Server {
  server: FastifyInstance;
  dispatcher: Dispatcher;
}

// The dispatcher whose runs reach the provider through `providerFetch`.
export function dispatcherFor(providerFetch?: typeof fetch): Dispatcher {
  return createDispatcher({
    run: (input) => runSession(input, providerFetch),
  });
}

// Opens no database, so describing the API builds the same server boot does.
export async function buildServer(
  options: ServerOptions = {},
): Promise<Server> {
  const dispatcher = dispatcherFor(options.providerFetch);
  const server = Fastify({
    logger: options.logger ?? false,
    trustProxy: true,
    // Long-lived frontend SSE streams would otherwise hold close() open forever.
    forceCloseConnections: true,
  });
  await registerApi(server, { dispatcher });
  // Outside /api: a container probe is infrastructure, not API surface.
  server.get("/health", async () => ({ status: "ok" }));
  return { server, dispatcher };
}
