import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { LLM_PROVIDER_NAMES, SANDBOX_NETWORKS } from "@nightwarden/shared";
import { inList } from "../schema-helpers.js";

export const config = sqliteTable(
  "config",
  {
    id: text("id").primaryKey(),
    activeProvider: text("active_provider", { enum: LLM_PROVIDER_NAMES }),
    maxRetries: integer("max_retries").notNull().default(3),
    maxInvestigationsPerHour: integer("max_investigations_per_hour")
      .notNull()
      .default(10),
    checkInAfterMs: integer("check_in_after_ms").notNull().default(1800000),
    toolCallCeilingMs: integer("tool_call_ceiling_ms")
      .notNull()
      .default(600000),
    sandboxIdleTimeoutMs: integer("sandbox_idle_timeout_ms")
      .notNull()
      .default(3600000),
    sandboxCpus: integer("sandbox_cpus").notNull().default(2),
    sandboxMemoryMb: integer("sandbox_memory_mb").notNull().default(4096),
    sandboxNetwork: text("sandbox_network", { enum: SANDBOX_NETWORKS })
      .notNull()
      .default("allowlist"),
    // Newline-joined, the Settings textarea's own shape.
    sandboxAllowlistHosts: text("sandbox_allowlist_hosts")
      .notNull()
      .default(
        [
          "registry.npmjs.org",
          "registry.yarnpkg.com",
          "repo.yarnpkg.com",
          "classic.yarnpkg.com",
          "pypi.org",
          "files.pythonhosted.org",
          "crates.io",
          "index.crates.io",
          "static.crates.io",
          "static.rust-lang.org",
          "sh.rustup.rs",
          "proxy.golang.org",
          "sum.golang.org",
          "dl.google.com",
          "go.dev",
          "rubygems.org",
          "index.rubygems.org",
          "repo.packagist.org",
          "packagist.org",
          "repo.hex.pm",
          "hex.pm",
          "builds.hex.pm",
          "api.nuget.org",
          "builds.dotnet.microsoft.com",
          "dot.net",
          "ci.dot.net",
          "nodejs.org",
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
          "mise-versions.jdx.dev",
          "mise-java.jdx.dev",
          "tuf-repo-cdn.sigstore.dev",
        ].join("\n"),
      ),
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
