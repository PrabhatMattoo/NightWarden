import { z } from "zod";
import { THEME_PREFERENCES } from "../auth.js";
import {
  LLM_PROVIDER_NAMES,
  SANDBOX_HOST_PATTERN,
  SANDBOX_NETWORKS,
  SETTING_RANGES,
  type NumericSetting,
} from "../config.js";

export const llmProviderNameSchema = z.enum(LLM_PROVIDER_NAMES);
export const themePreferenceSchema = z.enum(THEME_PREFERENCES);

// One sentence per setting, naming both bounds, whichever of them was crossed.
function bounded(setting: NumericSetting) {
  const { min, max } = SETTING_RANGES[setting];
  const bounds = `${setting} must be a whole number from ${min} to ${max}`;
  return z
    .number({ error: bounds })
    .int(bounds)
    .min(min, bounds)
    .max(max, bounds);
}

// reasoningLevel is free here: the model's own descriptor is the authority on it.
const providerPatchSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  baseUrl: z.url().nullable().optional(),
  reasoningLevel: z.string().min(1).nullable().optional(),
});

// Nested under `providers`, so a change to one cannot touch another's model or key.
export const configPatchSchema = z.object({
  provider: llmProviderNameSchema.nullable().optional(),
  providers: z
    .object({
      anthropic: providerPatchSchema.optional(),
      openai: providerPatchSchema.optional(),
      openrouter: providerPatchSchema.optional(),
    })
    .optional(),
  maxRetries: bounded("maxRetries").optional(),
  maxInvestigationsPerHour: bounded("maxInvestigationsPerHour").optional(),
  checkInAfterMs: bounded("checkInAfterMs").optional(),
  toolCallCeilingMs: bounded("toolCallCeilingMs").optional(),
  sandboxIdleTimeoutMs: bounded("sandboxIdleTimeoutMs").optional(),
  sandboxCpus: bounded("sandboxCpus").optional(),
  sandboxMemoryMb: bounded("sandboxMemoryMb").optional(),
  sandboxRequireGvisor: z.boolean().optional(),
  sandboxNetwork: z.enum(SANDBOX_NETWORKS).optional(),
  sandboxAllowlistHosts: z
    .array(
      z
        .string()
        .regex(SANDBOX_HOST_PATTERN, "hostnames only, e.g. registry.npmjs.org"),
    )
    .min(1)
    .optional(),
});
export type ConfigPatch = z.infer<typeof configPatchSchema>;
