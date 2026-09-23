// Global agent config: how the one brain reasons (no per-runner dimension). Every
// value here is API-seeded and safe to send to the frontend; keys are masked.

export const LLM_PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "openrouter",
] as const;
export type LLMProviderName = (typeof LLM_PROVIDER_NAMES)[number];

// "allowlist" routes all sandbox egress through an enforcing proxy that only
// reaches approved hosts; "none" gives no network at all; "open" is unrestricted.
export const SANDBOX_NETWORKS = ["allowlist", "open", "none"] as const;
export type SandboxNetwork = (typeof SANDBOX_NETWORKS)[number];

// Hostnames only, so a scheme, a port or a path is refused rather than guessed at.
export const SANDBOX_HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export interface SettingRange {
  min: number;
  max: number;
  presets: readonly number[];
}

/* What each numeric setting may hold, and the values the settings page offers.
   The API validates against the same bounds, so the page never offers a refusal. */
export const SETTING_RANGES = {
  maxConcurrentInvestigations: {
    min: 1,
    max: 20,
    presets: [1, 2, 3, 5, 10, 15, 20],
  },
  checkInAfterMs: {
    min: 5 * MINUTE,
    max: 4 * HOUR,
    presets: [10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR],
  },
  requestTimeoutMs: {
    min: 30 * SECOND,
    max: 10 * MINUTE,
    presets: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
  },
  maxRetries: { min: 0, max: 5, presets: [0, 1, 2, 3, 5] },
  toolCallCeilingMs: {
    min: MINUTE,
    max: 30 * MINUTE,
    presets: [MINUTE, 5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 30 * MINUTE],
  },
  sandboxIdleTimeoutMs: {
    min: 15 * MINUTE,
    max: 4 * HOUR,
    presets: [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR],
  },
  sandboxCpus: { min: 1, max: 8, presets: [1, 2, 4, 8] },
  sandboxMemoryMb: {
    min: 1024,
    max: 16384,
    presets: [1024, 2048, 4096, 8192, 16384],
  },
} as const satisfies Record<string, SettingRange>;

export type NumericSetting = keyof typeof SETTING_RANGES;

// Served rather than hardcoded, so a new adapter appears in the frontend
// without a UI change.
export interface ProviderOption {
  name: LLMProviderName;
  label: string;
  defaultBaseUrl: string;
}

// The response decides: a rejected request with no key asked for one, and the
// same rejection with a key means that key is wrong.
export type CatalogError = "needs_key" | "bad_key" | "unreachable";

// Listing the catalog is also how setup is verified: models coming back prove
// the endpoint is reachable and the key works, so nothing separate is pressed.
export type ModelCatalog =
  { ok: true; models: ModelOption[] } | { ok: false; error: CatalogError };

// One rung of a provider's reasoning ladder, in that provider's own vocabulary.
export interface ReasoningLevel {
  value: string;
  label: string;
}

// Normalised from whichever catalog it came from, so the frontend renders it
// and never branches on the provider name.
export interface ReasoningDescriptor {
  // Ordered strongest to weakest. Ladders have holes (Opus 4.6 has max but not
  // xhigh), so this is the authority rather than any assumed ordering.
  levels: ReasoningLevel[];
  defaultLevel: string;
}

// One entry of a provider's model catalog, carrying what the settings form
// draws. A run reads a model's limits server-side, where it resolves them.
export interface ModelOption {
  id: string;
  // null when the model exposes no reasoning control at all.
  reasoning: ReasoningDescriptor | null;
}

// How to reach one provider. Each keeps its own credentials, so switching the
// active provider cannot carry the previous one's key or endpoint across.
export interface ProviderSettings {
  model: string | null;
  // Unset means the provider's own endpoint. Set it to reach a gateway or a
  // self-hosted deployment of the same API.
  baseUrl?: string;
  // Computed server-side on read and never stored; the plaintext never leaves.
  apiKeyMasked?: string | null;
  // Validated against the model's descriptor rather than a fixed union: the
  // levels differ per model, so an enum here could only be a guess.
  reasoningLevel: string | null;
}

// One shape per provider, holding the choices that provider was configured with.
export type ProviderSettingsMap = Record<LLMProviderName, ProviderSettings>;

export interface AgentConfig {
  // Which provider block is live; null until a user picks one. There is no
  // default: a fresh install must not look configured when it can reach no LLM.
  provider: LLMProviderName | null;
  providers: ProviderSettingsMap;
  // The adapters this build offers, carried here so the picker is data the
  // frontend renders rather than a list it maintains.
  providerOptions: ProviderOption[];
  maxRetries: number;
  requestTimeoutMs: number;
  // Counts the suspended ones too: starting another only queues a second write
  // behind the same person.
  maxConcurrentInvestigations: number;
  // How long the agent works before finishing its current step and asking
  // whether to continue. The continue gate is what it reaches, not a kill.
  checkInAfterMs: number;
  // Upper bound on any single tool call. Tools declare their own lower limits.
  toolCallCeilingMs: number;
  sandboxIdleTimeoutMs: number;
  sandboxCpus: number;
  sandboxMemoryMb: number;
  // Fail-loud: refuses to start unless the Docker host has gVisor (runsc).
  // Off by default, gVisor is used automatically wherever present.
  sandboxRequireGvisor: boolean;
  sandboxNetwork: SandboxNetwork;
  // Domains the allowlist proxy may reach, one hostname per entry.
  sandboxAllowlistHosts: string[];
}

// Only the readiness gate builds one, so holding it is proof the install is
// configured and no call site has to re-check.
export interface ResolvedLLMConfig {
  provider: LLMProviderName;
  model: string;
  baseUrl?: string;
  // The chosen model's own ceiling, or a constant when it published none.
  maxOutputTokens: number;
  // Both are facts the catalog stated. What to do with them is each adapter's
  // arithmetic, so no threshold is decided here.
  maxInputTokens: number | null;
  compaction: boolean;
  maxRetries: number;
  requestTimeoutMs: number;
  // The user's pick, in the provider's vocabulary; each adapter translates
  // it into its own wire param. Null means send nothing and take the default.
  reasoningLevel: string | null;
  // The ladder the pick came from. Null means the model publishes none, and an
  // adapter with no ladder sends no reasoning params at all rather than guessing.
  reasoning: ReasoningDescriptor | null;
}
