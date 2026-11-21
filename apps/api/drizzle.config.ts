import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./src/session/schema.ts",
    "./src/fleet/schema.ts",
    "./src/integrations/schema.ts",
    "./src/config/schema.ts",
    "./src/auth/schema.ts",
  ],
  out: "./src/migrations",
});
