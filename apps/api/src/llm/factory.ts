import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type {
  LanguageModelV4,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { ResolvedLLMConfig } from "@nightwarden/shared";
import { baseUrlFor } from "./catalog.js";
import { SdkProvider } from "./provider.js";
import { toolSchemaFor } from "./tool-schema-dialects.js";
import type { LLMProvider, ProviderCallOptions } from "./types.js";

// `providerFetch` stands in for the network, so a test serves the provider's own wire.
export function languageModel(
  config: Pick<ResolvedLLMConfig, "provider" | "model" | "baseUrl">,
  apiKey?: string,
  providerFetch?: typeof fetch,
): LanguageModelV4 {
  const baseURL = baseUrlFor(config.provider, config.baseUrl);
  // The readiness gate refuses a provider with no address, so this is a bug.
  if (baseURL === null) throw new Error(`${config.provider} has no base URL`);
  const settings = {
    ...(apiKey !== undefined && { apiKey }),
    ...(providerFetch !== undefined && { fetch: providerFetch }),
    baseURL,
  };
  switch (config.provider) {
    case "anthropic":
      return createAnthropic(settings)(config.model);
    case "openai":
      return createOpenAI(settings).responses(config.model);
    case "openrouter":
      return createOpenRouter(settings).chat(config.model);
    case "openai-compatible":
      return createOpenAICompatible({
        ...settings,
        name: "openai-compatible",
        // Servers report no usage on a stream unless asked.
        includeUsage: true,
      }).chatModel(config.model);
  }
}

/* The rung to ask for. Reasoning is never switched off: a model told not to
   reason writes its tool calls as prose instead of calling them. */
function effort(
  config: ResolvedLLMConfig,
  opts?: ProviderCallOptions,
): string | null {
  const levels = config.reasoning?.levels ?? [];
  // Ordered strongest to weakest, so the last rung is the cheapest offered.
  return opts?.minimalReasoning
    ? (levels[levels.length - 1]?.value ?? null)
    : config.reasoningLevel;
}

// Anthropic's automatic caching: one breakpoint that follows the conversation's tail.
const CACHE_TAIL = { type: "ephemeral" } as const;

// The only place a provider is named for what a request carries. Each level came
// from that provider's own catalogue, so it passes through unmapped.
export function requestOptions(
  config: ResolvedLLMConfig,
  opts?: ProviderCallOptions,
): SharedV4ProviderOptions {
  const level = effort(config, opts);
  switch (config.provider) {
    case "anthropic":
      return {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized" },
          cacheControl: CACHE_TAIL,
          ...(level !== null && { effort: level }),
          // No trigger: Anthropic's own default decides when, and a number of
          // ours would be a guess dressed as a setting.
          ...(config.compaction && {
            contextManagement: { edits: [{ type: "compact_20260112" }] },
          }),
        },
      };
    case "openai": {
      const threshold = compactThreshold(config);
      return {
        openai: {
          ...(level !== null && { reasoningEffort: level }),
          ...(threshold !== null && {
            contextManagement: [
              { type: "compaction", compactThreshold: threshold },
            ],
          }),
        },
      };
    }
    // Read by Anthropic's models and ignored by the rest, as OpenRouter does any
    // parameter a model cannot take.
    case "openrouter":
      return {
        openrouter: {
          cacheControl: CACHE_TAIL,
          ...(level !== null && { reasoning: { effort: level } }),
        },
      };
    // A server states a ladder only when its list does, so most runs send nothing.
    case "openai-compatible":
      return level === null
        ? {}
        : { openaiCompatible: { reasoningEffort: level } };
  }
}

/* OpenAI requires a threshold, so it gets the highest one that can ever fire:
   the reply is reserved out of the window, so input can never reach the whole of it. */
function compactThreshold(config: ResolvedLLMConfig): number | null {
  const window = config.maxInputTokens;
  if (!config.compaction || window === null) return null;
  const reachable = window - config.maxOutputTokens;
  return reachable > 0 ? reachable : null;
}

// Taking a ResolvedLLMConfig means an unconfigured install cannot reach here:
// the readiness gate is the only way to obtain one.
export function createProvider(
  model: LanguageModelV4,
  system: string,
  config: ResolvedLLMConfig,
  opts?: ProviderCallOptions,
): LLMProvider {
  return new SdkProvider(model, system, {
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: config.maxRetries,
    toolSchema: (schema) => toolSchemaFor(config.provider, schema),
    providerOptions: requestOptions(config, opts),
    ...(opts?.onRetry !== undefined && { onRetry: opts.onRetry }),
  });
}
