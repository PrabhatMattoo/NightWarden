// Global agent config: how the one brain reasons (no per-runner dimension). Every
// value here is API-seeded and safe to send to the frontend; keys are masked.
import type { ReasoningDescriptor, ReasoningLevel } from "./schemas/config.js";

export const LLM_PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "openrouter",
  "openai-compatible",
] as const;
export type LLMProviderName = (typeof LLM_PROVIDER_NAMES)[number];

// "allowlist" routes all sandbox egress through an enforcing proxy that only
// reaches approved hosts; "none" gives no network at all; "open" is unrestricted.
export const SANDBOX_NETWORKS = ["allowlist", "open", "none"] as const;
export type SandboxNetwork = (typeof SANDBOX_NETWORKS)[number];

// Hostnames only, so a scheme, a port or a path is refused rather than guessed at.
export const SANDBOX_HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface SettingRange {
  min: number;
  max: number;
  presets: readonly number[];
}

/* What each numeric setting may hold, and the values the settings page offers.
   The API validates against the same bounds, so the page never offers a refusal. */
export const SETTING_RANGES = {
  maxInvestigationsPerHour: {
    min: 1,
    max: 100,
    presets: [1, 5, 10, 20, 50, 100],
  },
  checkInAfterMs: {
    min: 5 * MINUTE,
    max: 4 * HOUR,
    presets: [10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR],
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

/* Every level any provider names, strongest first, because a ladder has holes
   and the weakest one offered is what a cheap call asks for. */
export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  { value: "max", label: "Max" },
  { value: "xhigh", label: "Extra high" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "minimal", label: "Minimal" },
];

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
  // The user's pick, in the provider's vocabulary; each adapter translates
  // it into its own wire param. Null means send nothing and take the default.
  reasoningLevel: string | null;
  // The ladder the pick came from. Null means the model publishes none, and an
  // adapter with no ladder sends no reasoning params at all rather than guessing.
  reasoning: ReasoningDescriptor | null;
}
