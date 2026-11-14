import type { FastifyInstance } from "fastify";
import { installRouteSchemas } from "../route-schemas.js";

type Registrar = (instance: FastifyInstance) => Promise<void>;

// Mounts under /api as registerApi does, so seam tests drive the real URLs.
export async function mountApi(
  server: FastifyInstance,
  ...registrars: Registrar[]
): Promise<void> {
  await server.register(
    async (api) => {
      installRouteSchemas(api);
      for (const register of registrars) await register(api);
    },
    { prefix: "/api" },
  );
}
