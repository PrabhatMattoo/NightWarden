import { z } from "zod";
import {
  LLM_PROVIDER_NAMES,
  PROVIDER_SETTING_FIELDS,
  SANDBOX_NETWORKS,
  type AgentConfig,
  type GlobalSettingField,
  type LLMProviderName,
  type NumericSetting,
  type ProviderSettingField,
} from "@nightwarden/shared";
import {
  bounded,
  configPatchSchema,
  llmProviderNameSchema,
} from "@nightwarden/shared/schemas";
import { readable } from "../route-schemas.js";
import { readSecretEnv } from "../secrets.js";

const number = (setting: NumericSetting) =>
  z.string().transform(Number).pipe(bounded(setting));

// The one list replaces the effective allowlist, defaults included.
const hostList = z
  .string()
  .transform((text) => text.split(",").map((host) => host.trim()))
  .pipe(configPatchSchema.shape.sandboxAllowlistHosts.unwrap());

// Each global setting beside its variable and the rules the API holds a person to.
const GLOBAL_SETTINGS = {
  provider: {
    variable: "NIGHTWARDEN_LLM_PROVIDER",
    schema: llmProviderNameSchema,
  },
  maxRetries: {
    variable: "NIGHTWARDEN_MAX_RETRIES",
    schema: number("maxRetries"),
  },
  maxInvestigationsPerHour: {
    variable: "NIGHTWARDEN_MAX_INVESTIGATIONS_PER_HOUR",
    schema: number("maxInvestigationsPerHour"),
  },
  checkInAfterMs: {
    variable: "NIGHTWARDEN_CHECK_IN_AFTER_MS",
    schema: number("checkInAfterMs"),
  },
  toolCallCeilingMs: {
    variable: "NIGHTWARDEN_TOOL_CALL_CEILING_MS",
    schema: number("toolCallCeilingMs"),
  },
  sandboxIdleTimeoutMs: {
    variable: "NIGHTWARDEN_SANDBOX_IDLE_TIMEOUT_MS",
    schema: number("sandboxIdleTimeoutMs"),
  },
  sandboxCpus: {
    variable: "NIGHTWARDEN_SANDBOX_CPUS",
    schema: number("sandboxCpus"),
  },
  sandboxMemoryMb: {
    variable: "NIGHTWARDEN_SANDBOX_MEMORY_MB",
    schema: number("sandboxMemoryMb"),
  },
  sandboxNetwork: {
    variable: "NIGHTWARDEN_SANDBOX_NETWORK",
    schema: z.enum(SANDBOX_NETWORKS),
  },
  sandboxAllowlistHosts: {
    variable: "NIGHTWARDEN_SANDBOX_ALLOWLIST_HOSTS",
    schema: hostList,
  },
} as const satisfies Record<
  GlobalSettingField,
  { variable: string; schema: z.ZodType<unknown, string> }
>;

const readVariable = (name: string): string | undefined =>
  process.env[name] || undefined;

// Each provider field has a variable named for the provider; the key may come from a file.
const PROVIDER_SETTINGS = {
  model: { suffix: "MODEL", read: readVariable, schema: z.string() },
  baseUrl: { suffix: "BASE_URL", read: readVariable, schema: z.url() },
  apiKey: { suffix: "API_KEY", read: readSecretEnv, schema: z.string() },
  reasoningLevel: {
    suffix: "REASONING_LEVEL",
    read: readVariable,
    schema: z.string(),
  },
} as const satisfies Record<
  ProviderSettingField,
  {
    suffix: string;
    read: (name: string) => string | undefined;
    schema: z.ZodType<string, string>;
  }
>;

type EnvSettings = {
  [F in GlobalSettingField]?: z.output<(typeof GLOBAL_SETTINGS)[F]["schema"]>;
};
type ProviderEnv = Partial<Record<ProviderSettingField, string>>;

interface EnvConfig {
  settings: EnvSettings;
  providers: Partial<Record<LLMProviderName, ProviderEnv>>;
  // The variable that set each value above, which is what the page tells a person to unset.
  locked: AgentConfig["locked"];
}

function parseVariable<S extends z.ZodType<unknown, string>>(
  variable: string,
  raw: string,
  schema: S,
): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${variable} is invalid: ${readable(parsed.error)}`);
  }
  return parsed.data;
}

function readEnvConfig(): EnvConfig {
  const settings: Record<string, unknown> = {};
  const lockedSettings: Record<string, string> = {};
  for (const [field, { variable, schema }] of Object.entries(GLOBAL_SETTINGS)) {
    const raw = readVariable(variable);
    if (raw === undefined) continue;
    settings[field] = parseVariable(variable, raw, schema);
    lockedSettings[field] = variable;
  }

  const providers: EnvConfig["providers"] = {};
  const lockedProviders: EnvConfig["locked"]["providers"] = {};
  for (const provider of LLM_PROVIDER_NAMES) {
    // A hyphen is not legal in a variable name.
    const prefix = provider.toUpperCase().replaceAll("-", "_");
    const block: ProviderEnv = {};
    const lockedBlock: Partial<Record<ProviderSettingField, string>> = {};
    for (const field of PROVIDER_SETTING_FIELDS) {
      const { suffix, read, schema } = PROVIDER_SETTINGS[field];
      const variable = `NIGHTWARDEN_${prefix}_${suffix}`;
      const raw = read(variable);
      if (raw === undefined) continue;
      block[field] = parseVariable(variable, raw, schema);
      lockedBlock[field] = variable;
    }
    if (Object.keys(block).length > 0) {
      providers[provider] = block;
      lockedProviders[provider] = lockedBlock;
    }
  }

  return {
    // Each entry above was parsed by the schema of the field it is filed under.
    settings: settings as EnvSettings,
    providers,
    locked: { settings: lockedSettings, providers: lockedProviders },
  };
}

let resolved: EnvConfig | null = null;

// Read once so a bad value refuses the boot, and so every later read agrees.
export function initEnv(): void {
  resolved = readEnvConfig();
}

export function envConfig(): EnvConfig {
  if (resolved === null) {
    throw new Error("the environment is not read; initEnv() runs at boot");
  }
  return resolved;
}
