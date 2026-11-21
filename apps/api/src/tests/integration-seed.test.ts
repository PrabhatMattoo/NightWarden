import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSecrets } from "../secrets.js";
import { connectTestMetrics, useTempDb } from "./temp-db.js";
import { seedIntegrationsFromEnv } from "../integrations/seed.js";
import { metricsSourceRow } from "../integrations/metrics/store.js";
import { getDb } from "../db.js";
import { integrations } from "../integrations/schema.js";
import { getLokiIntegration } from "../integrations/store.js";

// A fresh install can come up with its evidence integrations connected without
// anyone opening a browser.
describe("first-boot integration seed from the environment", () => {
  let cleanupDb: () => void;

  beforeEach(() => {
    cleanupDb = useTempDb();
    vi.stubEnv(
      "NIGHTWARDEN_SECRET_KEY",
      "test-only-secret-key-for-seed-tests-32bytes",
    );
    initSecrets();
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /* Two shapes, because the two probes are two APIs: an instant query answers
     with a result envelope, and Loki's label listing with a bare array. */
  function answering(ok: boolean): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: unknown) => {
      if (!ok) return new Response("nope", { status: 502 });
      const url = input instanceof Request ? input.url : String(input);
      const data = url.includes("/api/v1/query")
        ? { resultType: "vector", result: [] }
        : [];
      return new Response(JSON.stringify({ status: "success", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("seeds Prometheus and Loki once the probe answers", () => {
    vi.stubEnv("PROMETHEUS_URL", "http://prom.internal:9090");
    vi.stubEnv("PROMETHEUS_AUTH_HEADER", "Bearer prom-secret");
    vi.stubEnv("LOKI_URL", "http://loki.internal:3100");
    vi.stubEnv("LOKI_ORG_ID", "tenant-a");
    vi.stubGlobal("fetch", answering(true));

    seedIntegrationsFromEnv();

    expect(metricsSourceRow()).toMatchObject({
      kind: "prometheus",
      queryUrl: "http://prom.internal:9090",
      // Prometheus serves its own rules, which is what makes recovery
      // verification work on a seeded install with nothing else configured.
      rulesUrl: "http://prom.internal:9090",
    });
    expect(getLokiIntegration()).toMatchObject({
      baseUrl: "http://loki.internal:3100",
      orgId: "tenant-a",
    });
    // The accessor hands back plaintext; the column never holds it.
    expect(metricsSourceRow()?.queryAuthorization).toBe("Bearer prom-secret");
    const stored = getDb()
      .select({ secrets: integrations.secrets })
      .from(integrations)
      .where(eq(integrations.kind, "prometheus"))
      .get()!;
    expect(stored.secrets).not.toContain("prom-secret");
  });

  it("never overwrites an integration the user already connected", () => {
    connectTestMetrics({ queryUrl: "http://chosen-by-user:9090" });
    vi.stubEnv("PROMETHEUS_URL", "http://from-stale-compose-file:9090");
    const fetchMock = answering(true);
    vi.stubGlobal("fetch", fetchMock);

    seedIntegrationsFromEnv();

    expect(metricsSourceRow()?.queryUrl).toBe("http://chosen-by-user:9090");
    // Boot dials nothing at all, whether or not a row is already there.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the variables are absent", () => {
    seedIntegrationsFromEnv();

    expect(metricsSourceRow()).toBeNull();
    expect(getLokiIntegration()).toBeNull();
  });
});
