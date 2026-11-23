import { sql } from "drizzle-orm";
import { vi } from "vitest";
import type { LLMProviderName } from "@nightwarden/shared";
import { getDb, resetDb } from "../db.js";
import { resetAuth } from "../auth/instance.js";
import {
  saveMetricsSource,
  type MetricsSourceInput,
} from "../integrations/metrics/store.js";
import { providerConfig } from "../config/schema.js";
import { updateConfig, updateProvider } from "../config/store.js";
import { seedCatalog } from "../llm/catalog.js";
import { createTempFolder } from "./temp-folder.js";

// The OpenAI adapter reads reasoning support from the id, so its model is a reasoning one.
const TEST_MODELS: Record<LLMProviderName, string> = {
  anthropic: "test-model",
  openai: "gpt-5",
  openrouter: "anthropic/claude-sonnet-4.5",
  "openai-compatible": "llama3.1:8b",
};

// The one provider with no address of its own; the fake answers at any URL.
const TEST_BASE_URLS: Partial<Record<LLMProviderName, string>> = {
  "openai-compatible": "http://localhost:11434/v1",
};

// Call at the top of beforeAll before anything opens the lazy db; pair the
// teardown with vi.unstubAllEnvs().
export function useTempDb(): () => void {
  const dir = createTempFolder();
  vi.stubEnv("NIGHTWARDEN_DIR", dir);
  configureTestLLM();
  return () => {
    // The auth instance holds the handle resetDb closes, so it goes with it.
    resetAuth();
    resetDb();
  };
}

/* Makes every audit insert fail until the returned function is called, so a test
   can see which writes roll back with it. A temp trigger needs no schema change. */
export function refuseAuditWrites(): () => void {
  getDb().run(
    sql`CREATE TEMP TRIGGER refuse_audit_writes BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT, 'refused'); END`,
  );
  return () => {
    getDb().run(sql`DROP TRIGGER temp.refuse_audit_writes`);
  };
}

// The run gate refuses without an LLM, so this is the baseline. Re-call after
// stubbing a new key: the stored one is encrypted with whichever was live.
export function configureTestLLM(
  provider: LLMProviderName = "anthropic",
): void {
  const model = TEST_MODELS[provider];
  // Anthropic is sent thinking on every request, the others reason once a level
  // is set, and a local server publishes no ladder to set one from.
  const reasons = provider !== "anthropic" && provider !== "openai-compatible";
  const baseUrl = TEST_BASE_URLS[provider];
  updateProvider(provider, {
    model,
    apiKey: "test-api-key",
    ...(baseUrl !== undefined && { baseUrl }),
    ...(reasons && { reasoningLevel: "high" }),
  });
  updateConfig({ provider });
  // A run resolves its model from the catalogue, which is seeded rather than
  // fetched so no test reaches a provider to start one.
  seedCatalog(provider, baseUrl, [
    {
      id: model,
      reasoning: reasons
        ? {
            levels: [
              { value: "high", label: "High" },
              { value: "low", label: "Low" },
            ],
            defaultLevel: "high",
          }
        : null,
      maxInputTokens: 200_000,
      maxOutputTokens: 32_000,
      compaction: false,
    },
  ]);
}

export function clearTestLLM(): void {
  updateConfig({ provider: null });
  getDb().delete(providerConfig).run();
}

// One connected Prometheus, serving its own rules: the ordinary single-source
// install every seam downstream of a metrics connection assumes.
export function connectTestMetrics(
  over: Partial<MetricsSourceInput> = {},
): void {
  saveMetricsSource({
    kind: "prometheus",
    label: "Prometheus",
    queryUrl: "http://prom.internal:9090",
    queryAuthorization: null,
    queryOrgId: null,
    rulesUrl: "http://prom.internal:9090",
    rulesAuthorization: null,
    rulesOrgId: null,
    ...over,
  });
}
