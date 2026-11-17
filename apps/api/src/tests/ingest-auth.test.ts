import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { fakeAnthropic } from "./fake-anthropic.js";
import {
  fakeRunner,
  harness,
  type Harness,
  type HarnessRunner,
} from "./harness.js";

// Every investigation an accepted delivery opens ends in one free-form turn.
const anthropic = fakeAnthropic();

import { createRunner } from "../fleet/runners-store.js";
import {
  deleteLokiIntegration,
  saveLokiIntegration,
} from "../integrations/store.js";
import {
  generateAlertSourceToken,
  getAlertSource,
} from "../integrations/alert-sources.js";

async function lastReceived(): Promise<string | null> {
  return (await getAlertSource("alertmanager"))?.lastReceivedAt ?? null;
}
import {
  clearTestLLM,
  configureTestLLM,
  connectTestMetrics,
} from "./temp-db.js";
import { deleteMetricsSource } from "../integrations/metrics/store.js";
import { dockerService, manifest } from "./manifest-helper.js";

const ALERTMANAGER_BODY = {
  alerts: [
    {
      status: "firing",
      labels: {
        alertname: "HighCPU",
        severity: "warning",
        container: "web-01",
      },
      annotations: { summary: "CPU high" },
      startsAt: new Date().toISOString(),
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "abc123",
    },
  ],
  version: "4",
  groupKey: "test",
  receiver: "nightwarden",
  status: "firing",
  groupLabels: {},
  commonLabels: {},
  commonAnnotations: {},
  externalURL: "http://localhost:9093",
};

// The anonymous Docker fallback identity every body in this file resolves to
// (no Compose labels, just `container: "web-01"`).
const WEB_01_SERVICE = dockerService("host-a", "web-01");

describe("POST /alerts/ingest auth", () => {
  let nw: Harness;
  let server: FastifyInstance;
  let VALID_TOKEN: string;
  let runner: HarnessRunner;

  beforeAll(async () => {
    nw = await harness({ model: anthropic, listen: false });
    ({ server } = nw);
    VALID_TOKEN = await generateAlertSourceToken("alertmanager");
    // A connected runner is an evidence source, so an accepted delivery opens an investigation.
    runner = fakeRunner({
      name: "auth-host",
      manifest: manifest("host-auth-test", [WEB_01_SERVICE]),
    });
  });

  afterAll(async () => {
    runner.disconnect();
    await nw.close();
    vi.unstubAllEnvs();
  });

  it("rejects unknown token with 401 before any processing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": `nwi_unknown-${randomUUID()}` },
      payload: ALERTMANAGER_BODY,
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/token/i);
    // A rejected request proves nothing about the pipe - no delivery stamp.
    expect(await lastReceived()).toBeNull();
  });

  it("rejects runner tokens - a runner credential grants runner things, never ingest", async () => {
    const runnerToken = (await createRunner("docker", "not-an-alert-source"))
      .plaintext;
    const res = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": runnerToken },
      payload: ALERTMANAGER_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(await lastReceived()).toBeNull();
  });

  it("rejects missing token with 401", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      payload: ALERTMANAGER_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts valid token and processes the alert", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": VALID_TOKEN },
      payload: ALERTMANAGER_BODY,
    });
    // 200 = processed (stored or skipped); not 401
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: number };
    expect(body.received).toBe(1);
    // Authenticated, well-formed delivery stamps the pipe as proven - even if
    // this particular alert dedups against an earlier test's routing.
    expect(await lastReceived()).not.toBeNull();
  });

  it("accepts a valid Authorization bearer token and processes the alert", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      // Its own fingerprint: sharing ALERTMANAGER_BODY with the header-token
      // test above deduped this one, so it processed nothing and still passed.
      payload: alertmanagerBody("nwi-bearer-auth"),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: number };
    expect(body.received).toBe(1);
  });
});

function alertmanagerBody(fingerprint: string): typeof ALERTMANAGER_BODY {
  return {
    alerts: [
      {
        status: "firing",
        labels: {
          alertname: "HighCPU",
          severity: "warning",
          container: "web-01",
        },
        annotations: { summary: "CPU high" },
        startsAt: new Date().toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint,
      },
    ],
    version: "4",
    groupKey: "test",
    receiver: "nightwarden",
    status: "firing",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://localhost:9093",
  };
}

describe("POST /alerts/ingest with nwi_ fleet-wide credential", () => {
  let nw: Harness;
  let server: FastifyInstance;
  let INGEST_TOKEN: string;

  beforeAll(async () => {
    nw = await harness({ model: anthropic, listen: false });
    ({ server } = nw);
    INGEST_TOKEN = await generateAlertSourceToken("alertmanager");
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  it("rejects only when neither a runner nor a pull-integration can supply evidence", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-no-evidence"),
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/runner|metrics|loki/i);
    // The webhook DID deliver: the stamp lands before the evidence gate, so the
    // page shows "receiving" even while investigation is blocked.
    expect(await lastReceived()).not.toBeNull();

    // Prometheus alone is a sufficient evidence source - the agentless path.
    await connectTestMetrics();
    const promOnly = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-prometheus-only"),
    });
    expect(promOnly.statusCode).toBe(200);
    expect((JSON.parse(promOnly.body) as { stored: number }).stored).toBe(1);
    await deleteMetricsSource();

    // Loki alone is likewise sufficient - a logs-first, no-metrics fleet.
    await saveLokiIntegration({
      baseUrl: "http://loki.internal:3100",
      orgId: null,
      authorization: null,
    });
    const lokiOnly = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-loki-only"),
    });
    expect(lokiOnly.statusCode).toBe(200);
    expect((JSON.parse(lokiOnly.body) as { stored: number }).stored).toBe(1);
    await deleteLokiIntegration();
  });

  it("returns 400 for an unrecognized payload body so a misconfigured sender learns its body was not understood", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
      payload: { notAlerts: true },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/unrecognized payload/i);
  });

  describe("with no language model configured", () => {
    afterEach(async () => {
      await configureTestLLM();
    });

    it("refuses the delivery with 503 and names what is missing, so Alertmanager retries rather than dropping the alert", async () => {
      await clearTestLLM();

      const res = await server.inject({
        method: "POST",
        url: "/api/alerts/ingest",
        headers: { "x-nightwarden-token": INGEST_TOKEN },
        payload: alertmanagerBody("nwi-unconfigured"),
      });

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toMatch(/no LLM is configured/i);
      expect(body.error).toMatch(/provider/i);
    });
  });
});
