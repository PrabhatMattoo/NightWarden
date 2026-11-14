import FastifySwagger from "@fastify/swagger";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
} from "fastify-type-provider-zod";
import { registerAlertRoutes } from "./alerts/ingest.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerTokenRoutes } from "./auth/token.js";
import { registerConfigRoutes } from "./config/routes.js";
import { registerInstallRoutes } from "./fleet/install.js";
import { registerRunnerRoutes } from "./fleet/routes.js";
import { registerWsRoutes } from "./fleet/server.js";
import { registerMetricsRoutes } from "./integrations/metrics/routes.js";
import { registerIntegrationRoutes } from "./integrations/routes.js";
import { installRouteSchemas } from "./route-schemas.js";
import { registerFrontendEventRoutes } from "./session/events.js";
import { registerSessionRoutes } from "./session/routes.js";

const ROUTES = [
  registerAuthRoutes,
  registerTokenRoutes,
  registerWsRoutes,
  registerFrontendEventRoutes,
  registerAlertRoutes,
  registerConfigRoutes,
  registerSessionRoutes,
  registerRunnerRoutes,
  registerInstallRoutes,
  registerIntegrationRoutes,
  registerMetricsRoutes,
];

// Under /api so the frontend owns every other path: /integrations/metrics
// and /sessions/:id each name both a page and an endpoint.
export async function registerApi(fastify: FastifyInstance): Promise<void> {
  await fastify.register(FastifyWebSocket);
  await fastify.register(FastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "NightWarden API",
        version: process.env.NW_VERSION ?? "dev",
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  await fastify.register(
    async (api) => {
      installRouteSchemas(api);
      for (const register of ROUTES) await register(api);
    },
    { prefix: "/api" },
  );
}
