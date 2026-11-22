import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@nightwarden/shared";
import { getDb } from "../db.js";
import { envConfig, initEnv } from "../config/env.js";
import { checkLLMReadiness } from "../config/readiness.js";
import { config, sandboxHostOverride } from "../config/schema.js";
import { harness, type Harness } from "./harness.js";

/* Every setting is the environment's, else the saved value, else the code's
   default, and nothing is copied from one to another. */
describe("where a setting comes from", () => {
  let nw: Harness;

  beforeEach(async () => {
    nw = await harness({ listen: false });
  });

  afterEach(async () => {
    await nw.close();
    vi.unstubAllEnvs();
    initEnv();
  });

  // The environment is read once at boot, so a test boots it again.
  function setEnv(variables: Record<string, string>): void {
    for (const [name, value] of Object.entries(variables)) {
      vi.stubEnv(name, value);
    }
    initEnv();
  }

  async function getConfig(): Promise<AgentConfig> {
    const res = await nw.server.inject({
      method: "GET",
      url: "/api/config",
      headers: nw.headers,
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as AgentConfig;
  }

  function patch(url: string, payload: Record<string, unknown>) {
    return nw.server.inject({
      method: "PATCH",
      url,
      headers: nw.headers,
      payload,
    });
  }

  const savedRow = () => getDb().select().from(config).get();

  it("takes the code's default until someone chooses, and stores only what was chosen", async () => {
    expect((await getConfig()).maxInvestigationsPerHour).toBe(10);
    expect(savedRow()?.maxInvestigationsPerHour).toBeNull();

    expect(
      (await patch("/api/config", { checkInAfterMs: 900_000 })).statusCode,
    ).toBe(200);

    const after = await getConfig();
    expect(after.checkInAfterMs).toBe(900_000);
    expect(after.maxInvestigationsPerHour).toBe(10);
    expect(savedRow()).toMatchObject({
      checkInAfterMs: 900_000,
      maxInvestigationsPerHour: null,
      maxRetries: null,
      sandboxNetwork: null,
    });
  });

  it("lets the environment beat a saved value and lock the field, until the variable is unset", async () => {
    await patch("/api/config", { maxRetries: 1 });

    setEnv({ NIGHTWARDEN_MAX_RETRIES: "4" });
    const locked = await getConfig();
    expect(locked.maxRetries).toBe(4);
    expect(locked.locked.settings).toEqual({
      maxRetries: "NIGHTWARDEN_MAX_RETRIES",
    });

    vi.unstubAllEnvs();
    initEnv();
    const unlocked = await getConfig();
    expect(unlocked.maxRetries).toBe(1);
    expect(unlocked.locked.settings).toEqual({});
  });

  it("refuses a patch touching a locked field with the variable's name, and changes nothing", async () => {
    setEnv({
      NIGHTWARDEN_MAX_RETRIES: "4",
      NIGHTWARDEN_ANTHROPIC_MODEL: "claude-from-env",
    });

    // The unlocked block would be written before the locked setting is reached.
    const global = await patch("/api/config", {
      providers: { anthropic: { baseUrl: "https://gateway.example" } },
      maxRetries: 2,
    });
    expect(global.statusCode).toBe(409);
    expect(global.body).toContain("NIGHTWARDEN_MAX_RETRIES");

    const block = await patch("/api/config", {
      maxInvestigationsPerHour: 7,
      providers: { anthropic: { model: "claude-typed" } },
    });
    expect(block.statusCode).toBe(409);
    expect(block.body).toContain("NIGHTWARDEN_ANTHROPIC_MODEL");

    const after = await getConfig();
    expect(after.maxInvestigationsPerHour).toBe(10);
    expect(after.providers.anthropic.baseUrl).toBeUndefined();
    expect(after.providers.anthropic.model).toBe("claude-from-env");
    expect(savedRow()?.maxRetries).toBeNull();
  });

  it("refuses a key typed over one the environment sets", async () => {
    setEnv({ NIGHTWARDEN_ANTHROPIC_API_KEY: "sk-ant-from-env-9999" });

    const res = await patch("/api/config/key", {
      provider: "anthropic",
      apiKey: "sk-ant-typed-0000",
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("NIGHTWARDEN_ANTHROPIC_API_KEY");
  });

  it("keeps the environment's reasoning level when only the model is picked", async () => {
    setEnv({ NIGHTWARDEN_ANTHROPIC_REASONING_LEVEL: "low" });

    const res = await patch("/api/config", {
      providers: { anthropic: { model: "test-model" } },
    });

    expect(res.statusCode).toBe(200);
    const picked = JSON.parse(res.body) as AgentConfig;
    expect(picked.providers.anthropic).toMatchObject({
      model: "test-model",
      reasoningLevel: "low",
    });
  });

  it("serves a provider key from the environment to a run, and to the page only masked", async () => {
    setEnv({ NIGHTWARDEN_ANTHROPIC_API_KEY: "sk-ant-from-env-9999" });

    const readiness = await checkLLMReadiness();
    expect(readiness).toMatchObject({
      ready: true,
      apiKey: "sk-ant-from-env-9999",
    });

    const res = await nw.server.inject({
      method: "GET",
      url: "/api/config",
      headers: nw.headers,
    });
    const shown = JSON.parse(res.body) as AgentConfig;
    expect(shown.providers.anthropic.apiKeyMasked).toBe("sk-...9999");
    expect(res.body).not.toContain("sk-ant-from-env-9999");
  });

  describe("the sandbox allowlist", () => {
    it("stores only the difference from the defaults, and deleting a row restores the default", async () => {
      const { sandboxDefaultHosts: defaults } = await getConfig();
      expect(defaults).toContain("pypi.org");

      await patch("/api/config", {
        sandboxAllowlistHosts: [
          ...defaults.filter((h) => h !== "pypi.org"),
          "internal.dev",
        ],
      });

      expect((await getConfig()).sandboxAllowlistHosts).toEqual([
        ...defaults.filter((h) => h !== "pypi.org"),
        "internal.dev",
      ]);
      expect(getDb().select().from(sandboxHostOverride).all()).toEqual([
        { host: "internal.dev", allowed: true },
        { host: "pypi.org", allowed: false },
      ]);

      await patch("/api/config", {
        sandboxAllowlistHosts: [...defaults, "internal.dev"],
      });

      expect(getDb().select().from(sandboxHostOverride).all()).toEqual([
        { host: "internal.dev", allowed: true },
      ]);
      expect((await getConfig()).sandboxAllowlistHosts).toContain("pypi.org");
    });

    it("is replaced whole by the environment's list, which locks it", async () => {
      setEnv({
        NIGHTWARDEN_SANDBOX_ALLOWLIST_HOSTS: "a.example.com, b.example.com",
      });

      const shown = await getConfig();

      expect(shown.sandboxAllowlistHosts).toEqual([
        "a.example.com",
        "b.example.com",
      ]);
      expect(shown.locked.settings.sandboxAllowlistHosts).toBe(
        "NIGHTWARDEN_SANDBOX_ALLOWLIST_HOSTS",
      );
    });
  });
});

describe("the environment at boot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    initEnv();
  });

  it("refuses to start on a value the Settings page would refuse, naming the variable", () => {
    vi.stubEnv("NIGHTWARDEN_MAX_RETRIES", "9");

    expect(() => initEnv()).toThrow("NIGHTWARDEN_MAX_RETRIES");
  });

  it("reads an empty variable as unset, as a compose file writes one", () => {
    vi.stubEnv("NIGHTWARDEN_MAX_RETRIES", "");
    vi.stubEnv("NIGHTWARDEN_ANTHROPIC_MODEL", "");

    initEnv();

    expect(envConfig().locked).toEqual({ settings: {}, providers: {} });
  });

  it("reads the trusted proxies as addresses and ranges, none when unset", () => {
    initEnv();
    expect(envConfig().trustedProxies).toEqual([]);

    vi.stubEnv(
      "NIGHTWARDEN_TRUSTED_PROXIES",
      " 10.0.0.1, 172.16.0.0/12,,fd00::1 , fd00::/8 ,",
    );
    initEnv();

    expect(envConfig().trustedProxies).toEqual([
      "10.0.0.1",
      "172.16.0.0/12",
      "fd00::1",
      "fd00::/8",
    ]);
  });

  it("refuses a trusted proxy that is neither an address nor a range, naming the variable", () => {
    vi.stubEnv("NIGHTWARDEN_TRUSTED_PROXIES", "10.0.0.1,proxy.internal");

    expect(() => initEnv()).toThrow("NIGHTWARDEN_TRUSTED_PROXIES");
  });
});
