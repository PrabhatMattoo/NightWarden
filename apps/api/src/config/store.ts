import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import {
  DEFAULT_CHECK_IN_AFTER_MS,
  DEFAULT_MAX_INVESTIGATIONS_PER_HOUR,
  DEFAULT_SANDBOX_ALLOWLIST_HOSTS,
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MEMORY_MB,
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_TOOL_CALL_CEILING_MS,
  MAX_RETRIES,
} from "../llm/config.js";
import { PROVIDER_OPTIONS, baseUrlFor, optionFor } from "../llm/catalog.js";
import { decrypt, encrypt, generateSecretKey, maskKey } from "../secrets.js";
import { secretKeyPath } from "../paths.js";
import { logger } from "../logger.js";
import { config, providerConfig } from "./schema.js";
import type {
  AgentConfig,
  LLMProviderName,
  ProviderSettings,
  ProviderSettingsMap,
  SettingsPatch,
} from "@nightwarden/shared";

const CONFIG_ID = "global";

// One list of providers in the build, held where they are described.
const PROVIDER_NAMES: readonly LLMProviderName[] = PROVIDER_OPTIONS.map(
  (p) => p.name,
);

type ProviderRow = typeof providerConfig.$inferSelect;

function readConfigRow(): typeof config.$inferSelect | undefined {
  return getDb().select().from(config).where(eq(config.id, CONFIG_ID)).get();
}

function readProviderRow(provider: LLMProviderName): ProviderRow | undefined {
  return getDb()
    .select()
    .from(providerConfig)
    .where(eq(providerConfig.provider, provider))
    .get();
}

// Stored newline-joined (the Settings textarea shape); empty lines dropped.
function splitHosts(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function maskStored(apiKeyEncrypted: string | null): string | null {
  return apiKeyEncrypted ? maskKey(decrypt(apiKeyEncrypted)) : null;
}

function toSettings(row: ProviderRow | undefined): ProviderSettings {
  return {
    model: row?.model ?? null,
    baseUrl: row?.baseUrl ?? undefined,
    apiKeyMasked: maskStored(row?.apiKeyEncrypted ?? null),
    reasoningLevel: row?.reasoningLevel ?? null,
  };
}

function loadProviders(): ProviderSettingsMap {
  const blocks = PROVIDER_NAMES.map(
    (name) => [name, toSettings(readProviderRow(name))] as const,
  );
  // fromEntries widens the keys to string; PROVIDER_NAMES is exactly the keys.
  return Object.fromEntries(blocks) as ProviderSettingsMap;
}

// Operational defaults are engineering choices and stay; which provider is active
// is the user's to pick, so it starts null and the run gate refuses until set.
export function loadConfig(): AgentConfig {
  const row = readConfigRow();
  const providers = loadProviders();
  if (!row) {
    return {
      provider: null,
      providers,
      providerOptions: [...PROVIDER_OPTIONS],
      maxRetries: MAX_RETRIES,
      maxInvestigationsPerHour: DEFAULT_MAX_INVESTIGATIONS_PER_HOUR,
      checkInAfterMs: DEFAULT_CHECK_IN_AFTER_MS,
      toolCallCeilingMs: DEFAULT_TOOL_CALL_CEILING_MS,
      sandboxIdleTimeoutMs: DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
      sandboxCpus: DEFAULT_SANDBOX_CPUS,
      sandboxMemoryMb: DEFAULT_SANDBOX_MEMORY_MB,
      sandboxNetwork: DEFAULT_SANDBOX_NETWORK,
      sandboxAllowlistHosts: [...DEFAULT_SANDBOX_ALLOWLIST_HOSTS],
    };
  }

  return {
    provider: row.activeProvider,
    providers,
    providerOptions: [...PROVIDER_OPTIONS],
    maxRetries: row.maxRetries,
    maxInvestigationsPerHour: row.maxInvestigationsPerHour,
    checkInAfterMs: row.checkInAfterMs,
    toolCallCeilingMs: row.toolCallCeilingMs,
    sandboxIdleTimeoutMs: row.sandboxIdleTimeoutMs,
    sandboxCpus: row.sandboxCpus,
    sandboxMemoryMb: row.sandboxMemoryMb,
    sandboxNetwork: row.sandboxNetwork,
    sandboxAllowlistHosts: splitHosts(row.sandboxAllowlistHosts),
  };
}

// The decrypted key for one provider, or undefined when it has none stored.
export function loadApiKey(provider: LLMProviderName): string | undefined {
  const row = readProviderRow(provider);
  return row?.apiKeyEncrypted ? decrypt(row.apiKeyEncrypted) : undefined;
}

// Global settings only; the per-provider blocks are written by updateProvider so
// a change to one provider can never disturb the other.
export function updateConfig(patch: SettingsPatch): AgentConfig {
  const next: AgentConfig = { ...loadConfig(), ...patch };
  const values = {
    activeProvider: next.provider,
    maxRetries: next.maxRetries,
    maxInvestigationsPerHour: next.maxInvestigationsPerHour,
    checkInAfterMs: next.checkInAfterMs,
    toolCallCeilingMs: next.toolCallCeilingMs,
    sandboxIdleTimeoutMs: next.sandboxIdleTimeoutMs,
    sandboxCpus: next.sandboxCpus,
    sandboxMemoryMb: next.sandboxMemoryMb,
    sandboxNetwork: next.sandboxNetwork,
    sandboxAllowlistHosts: next.sandboxAllowlistHosts.join("\n"),
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .insert(config)
    .values({ id: CONFIG_ID, ...values })
    .onConflictDoUpdate({ target: config.id, set: values })
    .run();
  return next;
}

export interface ProviderPatch {
  model?: string | null;
  baseUrl?: string | null;
  reasoningLevel?: string | null;
  // Plaintext; encrypted here so no caller has to remember to.
  apiKey?: string;
}

// Fields absent from the patch keep their stored value; the key is only replaced
// when a new one is supplied, so saving a model never clears the credential.
export function updateProvider(
  provider: LLMProviderName,
  patch: ProviderPatch,
): AgentConfig {
  const existing = readProviderRow(provider);
  const values = {
    provider,
    model: patch.model !== undefined ? patch.model : (existing?.model ?? null),
    baseUrl:
      patch.baseUrl !== undefined
        ? (patch.baseUrl ?? null)
        : (existing?.baseUrl ?? null),
    apiKeyEncrypted:
      patch.apiKey !== undefined
        ? encrypt(patch.apiKey)
        : (existing?.apiKeyEncrypted ?? null),
    reasoningLevel:
      patch.reasoningLevel !== undefined
        ? patch.reasoningLevel
        : (existing?.reasoningLevel ?? null),
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .insert(providerConfig)
    .values(values)
    .onConflictDoUpdate({ target: providerConfig.provider, set: values })
    .run();
  return loadConfig();
}

// Env is a first-boot seed, never a live source, so the database stays the one
// runtime source of truth.
export function seedConfigFromEnv(): void {
  for (const provider of PROVIDER_NAMES) {
    seedProviderFromEnv(provider);
  }

  const requested = process.env["NIGHTWARDEN_LLM_PROVIDER"];
  if (requested === undefined || requested === "") return;
  // Matched against the list rather than asserted, so the name is narrowed by
  // the same value the rest of this file iterates.
  const provider = PROVIDER_NAMES.find((name) => name === requested);
  if (provider === undefined) {
    logger.warn(
      { requested, expected: PROVIDER_NAMES },
      "NIGHTWARDEN_LLM_PROVIDER names no provider this build has; leaving the active provider unset",
    );
    return;
  }
  if (loadConfig().provider !== null) return;

  // Activating a block that cannot run would produce an install that looks
  // configured and fails at the first alert, so require what it needs first.
  const block = readProviderRow(provider);
  if (!block?.model || !hasKeyAndAddress(provider, block)) {
    logger.warn(
      { provider },
      "NIGHTWARDEN_LLM_PROVIDER is set but that provider is not fully set up; finish setup in the frontend",
    );
    return;
  }
  updateConfig({ provider });
  logger.info({ provider }, "active LLM provider seeded from environment");
}

// What readiness would ask of the stored block: the key where one is required,
// and an address where the provider has none of its own.
function hasKeyAndAddress(
  provider: LLMProviderName,
  block: ProviderRow,
): boolean {
  const keyed = !optionFor(provider).requiresKey || !!block.apiKeyEncrypted;
  return keyed && baseUrlFor(provider, block.baseUrl ?? undefined) !== null;
}

function seedProviderFromEnv(provider: LLMProviderName): void {
  // Only an untouched block is seeded: once a user has saved anything for a
  // provider, the database owns it and a stale compose file cannot overwrite it.
  const existing = readProviderRow(provider);
  if (existing?.model || existing?.apiKeyEncrypted) return;

  // A hyphen is not legal in a variable name.
  const prefix = provider.toUpperCase().replaceAll("-", "_");
  const model = process.env[`${prefix}_MODEL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  if (!model && !apiKey && !baseUrl) return;

  const missing: string[] = [];
  if (!model) missing.push(`${prefix}_MODEL`);
  if (!apiKey && optionFor(provider).requiresKey) {
    missing.push(`${prefix}_API_KEY`);
  }
  if (!baseUrl && optionFor(provider).defaultBaseUrl === null) {
    missing.push(`${prefix}_BASE_URL`);
  }
  if (!model || missing.length > 0) {
    logger.warn(
      { provider, missing },
      "incomplete provider environment; skipping seed for it",
    );
    return;
  }

  updateProvider(provider, {
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });
  logger.info({ provider, model }, "seeded provider settings from environment");
}

const KEY_CHECK = "nightwarden";

/* Written on first boot and decrypted on every boot after, so a database restored
   without its key refuses to start rather than reading each credential as unset. */
export function checkSecretKey(): void {
  const row = getDb()
    .select({ keyCheck: config.keyCheck })
    .from(config)
    .where(eq(config.id, CONFIG_ID))
    .get();
  if (row?.keyCheck == null) {
    generateSecretKey();
    const values = { keyCheck: encrypt(KEY_CHECK) };
    getDb()
      .insert(config)
      .values({
        id: CONFIG_ID,
        ...values,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({ target: config.id, set: values })
      .run();
    return;
  }
  let matches = false;
  try {
    matches = decrypt(row.keyCheck) === KEY_CHECK;
  } catch {
    // A missing key throws as well as a wrong one, and both are the same refusal.
  }
  if (!matches) {
    throw new Error(
      `the secret key does not decrypt this database's credentials: restore ${secretKeyPath()} from the same backup as the database, or set NIGHTWARDEN_SECRET_KEY to the key it held`,
    );
  }
}
