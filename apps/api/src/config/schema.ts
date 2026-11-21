import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { LLM_PROVIDER_NAMES, SANDBOX_NETWORKS } from "@nightwarden/shared";
import { inList } from "../schema-helpers.js";

// NULL in a setting column means nobody chose it, so the code's own default applies.
export const config = sqliteTable(
  "config",
  {
    id: text("id").primaryKey(),
    activeProvider: text("active_provider", { enum: LLM_PROVIDER_NAMES }),
    maxRetries: integer("max_retries"),
    maxInvestigationsPerHour: integer("max_investigations_per_hour"),
    checkInAfterMs: integer("check_in_after_ms"),
    toolCallCeilingMs: integer("tool_call_ceiling_ms"),
    sandboxIdleTimeoutMs: integer("sandbox_idle_timeout_ms"),
    sandboxCpus: integer("sandbox_cpus"),
    sandboxMemoryMb: integer("sandbox_memory_mb"),
    sandboxNetwork: text("sandbox_network", { enum: SANDBOX_NETWORKS }),
    keyCheck: text("key_check"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "config_active_provider",
      sql`${t.activeProvider} IN (${inList(LLM_PROVIDER_NAMES)})`,
    ),
    check(
      "config_sandbox_network",
      sql`${t.sandboxNetwork} IN (${inList(SANDBOX_NETWORKS)})`,
    ),
  ],
);

// One row per departure from the default allowlist: a host added, or a default taken away.
export const sandboxHostOverride = sqliteTable("sandbox_host_override", {
  host: text("host").primaryKey(),
  allowed: integer("allowed", { mode: "boolean" }).notNull(),
});

export const providerConfig = sqliteTable(
  "provider_config",
  {
    provider: text("provider", { enum: LLM_PROVIDER_NAMES }).primaryKey(),
    model: text("model"),
    baseUrl: text("base_url"),
    apiKeyEncrypted: text("api_key_encrypted"),
    // Plain text: the chosen model's descriptor decides the legal values.
    reasoningLevel: text("reasoning_level"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "provider_config_provider",
      sql`${t.provider} IN (${inList(LLM_PROVIDER_NAMES)})`,
    ),
  ],
);
