import { z } from "zod";
import { THEME_PREFERENCES } from "../auth.js";
import {
  LLM_PROVIDER_NAMES,
  type LLMProviderName,
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

// One entry per provider in the build, so a new name needs no edit here.
function perProvider<T extends z.ZodType>(entry: T) {
  return z.object(
    // fromEntries widens the keys to string; LLM_PROVIDER_NAMES is exactly the keys.
    Object.fromEntries(
      LLM_PROVIDER_NAMES.map((name) => [name, entry]),
    ) as Record<LLMProviderName, T>,
  );
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
  providers: perProvider(providerPatchSchema.optional()).optional(),
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
// The global settings alone: a provider block is written apart, so one cannot disturb another.
export type SettingsPatch = Omit<ConfigPatch, "providers">;

// Served rather than hardcoded, so a new adapter appears in the frontend
// without a UI change.
const providerOptionSchema = z.object({
  name: llmProviderNameSchema,
  label: z.string(),
  // Null where the address is the whole difference between servers, so the
  // person must enter one.
  defaultBaseUrl: z.string().nullable(),
  // False where a server may run open, as a local one often does.
  requiresKey: z.boolean(),
});
export type ProviderOption = z.infer<typeof providerOptionSchema>;

// One rung of a provider's reasoning ladder, in that provider's own vocabulary.
const reasoningLevelSchema = z.object({ value: z.string(), label: z.string() });
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

// Normalised from whichever catalog it came from, so the frontend never branches
// on the provider. Levels run strongest to weakest, and a ladder has holes.
const reasoningDescriptorSchema = z.object({
  levels: z.array(reasoningLevelSchema),
  defaultLevel: z.string(),
});
export type ReasoningDescriptor = z.infer<typeof reasoningDescriptorSchema>;

// `reasoning` is null when the model exposes no reasoning control at all.
const modelOptionSchema = z.object({
  id: z.string(),
  reasoning: reasoningDescriptorSchema.nullable(),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;

// The response decides: a rejected request with no key asked for one, and the
// same rejection with a key means that key is wrong.
const catalogErrorSchema = z.enum([
  "needs_key",
  "bad_key",
  "needs_url",
  "unreachable",
]);
export type CatalogError = z.infer<typeof catalogErrorSchema>;

// Listing the catalog is also how setup is verified: models coming back prove
// the endpoint is reachable and the key works.
export const modelCatalogSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), models: z.array(modelOptionSchema) }),
  z.object({ ok: z.literal(false), error: catalogErrorSchema }),
]);
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

// Why a model could not be used, and the one reason it can be reached and still
// fail: a reply that never called the tool.
const modelCheckReasonSchema = z.enum([
  "unreachable",
  "needs_url",
  "bad_key",
  "refused",
  "no_tool_call",
]);
export type ModelCheckReason = z.infer<typeof modelCheckReasonSchema>;

// A model that cannot call a tool cannot run an investigation. `detail` is the
// server's own words when it refused the request.
export const modelCheckSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: modelCheckReasonSchema,
    detail: z.string().optional(),
  }),
]);
export type ModelCheck = z.infer<typeof modelCheckSchema>;

// Unset baseUrl means the provider's own endpoint. The key is masked on read, so
// the plaintext never leaves.
const providerSettingsSchema = z.object({
  model: z.string().nullable(),
  baseUrl: z.string().optional(),
  apiKeyMasked: z.string().nullable().optional(),
  reasoningLevel: z.string().nullable(),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

const providerSettingsMapSchema = perProvider(providerSettingsSchema);
export type ProviderSettingsMap = z.infer<typeof providerSettingsMapSchema>;

// Every value here is safe to send to the frontend. `provider` is null until a
// user picks one, so a fresh install never looks configured.
export const agentConfigSchema = z.object({
  provider: llmProviderNameSchema.nullable(),
  providers: providerSettingsMapSchema,
  providerOptions: z.array(providerOptionSchema),
  maxRetries: z.number(),
  maxInvestigationsPerHour: z.number(),
  checkInAfterMs: z.number(),
  toolCallCeilingMs: z.number(),
  sandboxIdleTimeoutMs: z.number(),
  sandboxCpus: z.number(),
  sandboxMemoryMb: z.number(),
  sandboxRequireGvisor: z.boolean(),
  sandboxNetwork: z.enum(SANDBOX_NETWORKS),
  sandboxAllowlistHosts: z.array(z.string()),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const providerKeySavedSchema = z.object({
  provider: llmProviderNameSchema,
  apiKeyMasked: z.string(),
});
