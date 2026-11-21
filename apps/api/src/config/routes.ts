import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  loadConfig,
  loadApiKey,
  updateConfig,
  updateProvider,
  type ProviderPatch,
} from "./store.js";
import {
  PROVIDER_OPTIONS,
  baseUrlFor,
  catalogFor,
  fetchCatalog,
  offeredModels,
} from "../llm/catalog.js";
import { languageModel, type ModelFor } from "../llm/factory.js";
import { checkModelCallsTool } from "../llm/model-check.js";
import { maskKey } from "../secrets.js";
import { logger } from "../logger.js";
import type {
  LLMProviderName,
  ModelCatalog,
  ModelCheck,
  ModelOption,
} from "@nightwarden/shared";
import {
  agentConfigSchema,
  refusals,
  configPatchSchema,
  llmProviderNameSchema,
  modelCatalogSchema,
  modelCheckSchema,
  providerKeySavedSchema,
} from "@nightwarden/shared/schemas";

// Each field falls back to the stored value, so a half-typed form still asks
// something coherent. POST because a credential must never reach a URL.
const CatalogBodySchema = z.object({
  provider: llmProviderNameSchema.optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
});

// The same rules as the catalog, with the model to try: nothing is stored here.
const ModelCheckBodySchema = z.object({
  provider: llmProviderNameSchema,
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1),
});

// The provider is explicit: a key belongs to one provider's block, and inferring
// it from whichever is active would file the key under the wrong one mid-switch.
const KeyBodySchema = z.object({
  provider: llmProviderNameSchema,
  apiKey: z.string().min(1),
});

/* The only thing worth settling at pick time: a level carried over from the
   previous model may not exist on this one, so it re-resolves before it is stored. */
async function withValidLevel(
  provider: LLMProviderName,
  patch: ProviderPatch,
): Promise<ProviderPatch> {
  if (patch.model === undefined || patch.model === null) return patch;

  const config = loadConfig();
  const models = await catalogFor(
    provider,
    patch.baseUrl ?? config.providers[provider].baseUrl,
    loadApiKey(provider) ?? "",
  );
  const chosen = models.find((m) => m.id === patch.model);
  if (chosen === undefined) return patch;

  const level =
    patch.reasoningLevel ?? config.providers[provider].reasoningLevel;
  return { ...patch, reasoningLevel: validLevel(chosen, level) };
}

function validLevel(model: ModelOption, level: string | null): string | null {
  if (model.reasoning === null) return null;
  const supported = model.reasoning.levels.some((l) => l.value === level);
  return supported ? level : model.reasoning.defaultLevel;
}

export async function registerConfigRoutes(
  fastify: FastifyInstance,
  { modelFor = languageModel }: { modelFor?: ModelFor },
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const answersConfig = {
    response: { 200: agentConfigSchema, ...refusals() },
  };

  // gated: config includes provider/model/baseUrl — not for unauthenticated eyes
  app.get(
    "/config",
    { config: { permission: { settings: ["read"] } }, schema: answersConfig },
    async () => loadConfig(),
  );

  app.patch(
    "/config",
    {
      config: { permission: { settings: ["manage"] } },
      schema: { body: configPatchSchema, ...answersConfig },
    },
    async (request) => {
      // Provider blocks are written per provider so one cannot disturb the other;
      // everything else is global and goes through the single config row.
      const { providers, ...global } = request.body;
      for (const name of PROVIDER_OPTIONS.map((p) => p.name)) {
        const block = providers?.[name];
        if (block !== undefined)
          updateProvider(name, await withValidLevel(name, block));
      }
      const updated = updateConfig(global);
      logger.info(
        { keys: Object.keys(global), providers: Object.keys(providers ?? {}) },
        "agent config updated",
      );
      return updated;
    },
  );

  // Proxied because the key lives here and must never reach the frontend.
  // Listing verifies too: models coming back prove the endpoint and the key.
  app.post(
    "/config/models",
    {
      config: { permission: { settings: ["manage"] } },
      schema: {
        body: CatalogBodySchema,
        response: { 200: modelCatalogSchema, ...refusals() },
      },
    },
    async (request): Promise<ModelCatalog> => {
      const { provider, baseUrl, apiKey } = request.body;

      const config = loadConfig();
      const target = provider ?? config.provider;
      // Nothing to list until a provider is chosen.
      if (target === null || target === undefined) {
        return { ok: true, models: [] };
      }
      const stored = config.providers[target];
      // A typed key wins, otherwise the saved one, so changing a model or an
      // endpoint needs no re-pasting.
      const effectiveKey = apiKey ?? loadApiKey(target) ?? "";

      const catalog = await fetchCatalog(
        target,
        baseUrl ?? stored.baseUrl,
        effectiveKey,
      );
      logger.info(
        { provider: target, ok: catalog.ok },
        "model catalog requested",
      );
      return catalog.ok
        ? { ok: true, models: offeredModels(catalog.models) }
        : catalog;
    },
  );

  // The list cannot say whether a model calls tools, and one that cannot is no
  // use to a run, so this sends one turn the way a run would and sees.
  app.post(
    "/config/model-check",
    {
      config: { permission: { settings: ["manage"] } },
      schema: {
        body: ModelCheckBodySchema,
        response: { 200: modelCheckSchema, ...refusals() },
      },
    },
    async (request): Promise<ModelCheck> => {
      const { provider, model, apiKey } = request.body;
      const stored = loadConfig().providers[provider];
      const baseUrl = baseUrlFor(
        provider,
        request.body.baseUrl ?? stored.baseUrl,
      );
      if (baseUrl === null) return { ok: false, reason: "needs_url" };
      const key = apiKey ?? loadApiKey(provider) ?? "";
      const check = await checkModelCallsTool(
        modelFor({ provider, model, baseUrl }, key),
      );
      logger.info(
        { provider, model, ok: check.ok },
        "model tool-call check requested",
      );
      return check;
    },
  );

  app.patch(
    "/config/key",
    {
      config: { permission: { settings: ["manage"] } },
      schema: {
        body: KeyBodySchema,
        response: { 200: providerKeySavedSchema, ...refusals() },
      },
    },
    async (request) => {
      const { provider, apiKey } = request.body;
      updateProvider(provider, { apiKey });
      return { provider, apiKeyMasked: maskKey(apiKey) };
    },
  );
}
