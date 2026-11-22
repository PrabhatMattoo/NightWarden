import { asc, eq } from "drizzle-orm";
import { getDb, type Db } from "../db.js";
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
import { PROVIDER_OPTIONS } from "../llm/catalog.js";
import { apiKeyHint, decrypt, encrypt, generateSecretKey } from "../secrets.js";
import { secretKeyPath } from "../paths.js";
import { envConfig, refuseLocked } from "./env.js";
import { config, providerConfig, sandboxHostOverride } from "./schema.js";
import type {
  AgentConfig,
  ConfigPatch,
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

// Defaults in order, then added hosts, less any default a person removed.
function effectiveHosts(): string[] {
  const overrides = getDb()
    .select()
    .from(sandboxHostOverride)
    .orderBy(asc(sandboxHostOverride.host))
    .all();
  const hosts = new Set([
    ...DEFAULT_SANDBOX_ALLOWLIST_HOSTS,
    ...overrides.filter((o) => o.allowed).map((o) => o.host),
  ]);
  for (const o of overrides) if (!o.allowed) hosts.delete(o.host);
  return [...hosts];
}

// Stores only the difference from the defaults, so an improved default still arrives.
function replaceHostOverrides(hosts: readonly string[], db: Db): void {
  const wanted = new Set(hosts);
  const rows = [
    ...[...wanted]
      .filter((host) => !DEFAULT_SANDBOX_ALLOWLIST_HOSTS.includes(host))
      .map((host) => ({ host, allowed: true })),
    ...DEFAULT_SANDBOX_ALLOWLIST_HOSTS.filter((host) => !wanted.has(host)).map(
      (host) => ({ host, allowed: false }),
    ),
  ];
  db.delete(sandboxHostOverride).run();
  if (rows.length > 0) db.insert(sandboxHostOverride).values(rows).run();
}

function maskStored(apiKeyEncrypted: string | null): string | null {
  return apiKeyEncrypted ? apiKeyHint(decrypt(apiKeyEncrypted)) : null;
}

function toSettings(provider: LLMProviderName): ProviderSettings {
  const row = readProviderRow(provider);
  const env = envConfig().providers[provider];
  return {
    model: env?.model ?? row?.model ?? null,
    baseUrl: env?.baseUrl ?? row?.baseUrl ?? undefined,
    apiKeyMasked:
      env?.apiKey !== undefined
        ? apiKeyHint(env.apiKey)
        : maskStored(row?.apiKeyEncrypted ?? null),
    reasoningLevel: env?.reasoningLevel ?? row?.reasoningLevel ?? null,
  };
}

function loadProviders(): ProviderSettingsMap {
  const blocks = PROVIDER_NAMES.map(
    (name) => [name, toSettings(name)] as const,
  );
  // fromEntries widens the keys to string; PROVIDER_NAMES is exactly the keys.
  return Object.fromEntries(blocks) as ProviderSettingsMap;
}

// Each field is the environment's, else the saved value, else the code's default.
export function loadConfig(): AgentConfig {
  const row = readConfigRow();
  const { settings, locked } = envConfig();
  return {
    provider: settings.provider ?? row?.activeProvider ?? null,
    providers: loadProviders(),
    providerOptions: [...PROVIDER_OPTIONS],
    maxRetries: settings.maxRetries ?? row?.maxRetries ?? MAX_RETRIES,
    maxInvestigationsPerHour:
      settings.maxInvestigationsPerHour ??
      row?.maxInvestigationsPerHour ??
      DEFAULT_MAX_INVESTIGATIONS_PER_HOUR,
    checkInAfterMs:
      settings.checkInAfterMs ??
      row?.checkInAfterMs ??
      DEFAULT_CHECK_IN_AFTER_MS,
    toolCallCeilingMs:
      settings.toolCallCeilingMs ??
      row?.toolCallCeilingMs ??
      DEFAULT_TOOL_CALL_CEILING_MS,
    sandboxIdleTimeoutMs:
      settings.sandboxIdleTimeoutMs ??
      row?.sandboxIdleTimeoutMs ??
      DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
    sandboxCpus:
      settings.sandboxCpus ?? row?.sandboxCpus ?? DEFAULT_SANDBOX_CPUS,
    sandboxMemoryMb:
      settings.sandboxMemoryMb ??
      row?.sandboxMemoryMb ??
      DEFAULT_SANDBOX_MEMORY_MB,
    sandboxNetwork:
      settings.sandboxNetwork ?? row?.sandboxNetwork ?? DEFAULT_SANDBOX_NETWORK,
    sandboxAllowlistHosts: settings.sandboxAllowlistHosts ?? effectiveHosts(),
    sandboxDefaultHosts: [...DEFAULT_SANDBOX_ALLOWLIST_HOSTS],
    locked: { settings: locked.settings, providers: locked.providers },
  };
}

// The environment's key when set, else the stored one.
export function loadApiKey(provider: LLMProviderName): string | undefined {
  const fromEnv = envConfig().providers[provider]?.apiKey;
  if (fromEnv !== undefined) return fromEnv;
  const row = readProviderRow(provider);
  return row?.apiKeyEncrypted ? decrypt(row.apiKeyEncrypted) : undefined;
}

// Runs before any write, so a patch touching a locked field changes nothing.
export function refuseLockedFields(patch: ConfigPatch): void {
  const { settings, providers } = envConfig().locked;
  const { providers: blocks, ...global } = patch;
  refuseLocked(settings, global);
  for (const name of PROVIDER_NAMES) {
    refuseLocked(providers[name], blocks?.[name] ?? {});
  }
}

// Global settings only; updateProvider writes the per-provider blocks, so a
// change to one provider never disturbs the other. Only patched fields are written.
export function updateConfig(patch: SettingsPatch): AgentConfig {
  refuseLocked(envConfig().locked.settings, patch);
  const { provider, sandboxAllowlistHosts, ...columns } = patch;
  const values = {
    ...columns,
    ...(provider !== undefined && { activeProvider: provider }),
    updatedAt: new Date().toISOString(),
  };
  getDb().transaction((tx) => {
    tx.insert(config)
      .values({ id: CONFIG_ID, ...values })
      .onConflictDoUpdate({ target: config.id, set: values })
      .run();
    if (sandboxAllowlistHosts !== undefined) {
      replaceHostOverrides(sandboxAllowlistHosts, tx);
    }
  });
  return loadConfig();
}

export interface ProviderPatch {
  model?: string | null;
  baseUrl?: string | null;
  reasoningLevel?: string | null;
  // Plaintext; encrypted here so no caller has to remember to.
  apiKey?: string;
}

// Only patched fields are written, so saving a model keeps the credential.
export function updateProvider(
  provider: LLMProviderName,
  patch: ProviderPatch,
): AgentConfig {
  refuseLocked(envConfig().locked.providers[provider], patch);
  const { apiKey, ...columns } = patch;
  const values = {
    ...columns,
    ...(apiKey !== undefined && { apiKeyEncrypted: encrypt(apiKey) }),
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .insert(providerConfig)
    .values({ provider, ...values })
    .onConflictDoUpdate({ target: providerConfig.provider, set: values })
    .run();
  return loadConfig();
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
