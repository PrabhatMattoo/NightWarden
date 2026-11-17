import type { FastifyInstance } from "fastify";
import { installAuthorization } from "../auth/authorize.js";
import { installRouteSchemas } from "../route-schemas.js";

type Registrar = (instance: FastifyInstance) => Promise<void>;

// Mounts under /api behind the same gate registerApi installs, at the real URLs.
export async function mountApi(
  server: FastifyInstance,
  ...registrars: Registrar[]
): Promise<void> {
  await server.register(
    async (api) => {
      installRouteSchemas(api);
      installAuthorization(api);
      for (const register of registrars) await register(api);
    },
    { prefix: "/api" },
  );
}
