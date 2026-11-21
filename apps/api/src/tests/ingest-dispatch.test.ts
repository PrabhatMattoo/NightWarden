import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { harness, type Harness } from "./harness.js";
import { expectDuplicateAlert } from "./setup.js";
import {
  fakeModel,
  createGateController,
  messagesSentTo,
  type ScriptedTurn,
} from "./fake-model.js";
import { generateAlertSourceToken } from "../integrations/alert-sources.js";
import { isRunning } from "../session/status-store.js";
import { updateConfig } from "../config/store.js";
import { markAlertCleared } from "../session/alerts-store.js";
import { recordRunFailure } from "../session/status-store.js";
import {
  countInvestigations,
  getSession,
  listSessionFacts,
} from "../session/store.js";
import { appendErrorMessage } from "../session/transcript-store.js";
import { randomUUID } from "node:crypto";
import { waitFor } from "./wait.js";
import { seedAlertSession } from "./session-helper.js";
import { reconcileRecovery } from "../verification/reconciler.js";

// A free-form finish: no tool call ends the run successfully.
const FINISH: ScriptedTurn[] = [
  { toolUses: [], text: "Investigation complete." },
];

const scripted = fakeModel(FINISH);

// Shared FIFO gate. In gated mode a run parks on its request so it stays live
// long enough to assert against it; releaseAll() lets it finish.
const gate = createGateController();

function useGatedProvider(): void {
  scripted.park(gate.gate);
}

function useImmediateProvider(): void {
  scripted.park();
}

interface AlertSpec {
  fingerprint: string;
  container?: string;
  startsAt?: string;
  status?: "firing" | "resolved";
}

// groupKey is what Alertmanager computed from the user's group_by, and the
// only thing deciding which alerts share an investigation.
function delivery(groupKey: string, alerts: AlertSpec[], truncated = 0) {
  return {
    alerts: alerts.map((a) => ({
      status: a.status ?? "firing",
      labels: {
        alertname: "HighCPU",
        severity: "warning",
        container: a.container ?? "web-01",
      },
      annotations: { summary: "CPU high" },
      startsAt: a.startsAt ?? "2026-07-07T03:00:00.000Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: a.fingerprint,
    })),
    version: "4",
    groupKey,
    truncatedAlerts: truncated,
    receiver: "nightwarden",
    status: "firing",
    groupLabels: { alertname: "HighCPU" },
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://localhost:9093",
  };
}

describe("POST /alerts/ingest: one delivery, one investigation", () => {
  let nw: Harness;
  let token: string;

  beforeAll(async () => {
    nw = await harness({
      model: scripted,
      runners: [{ name: "host-web-01", services: ["web-01"] }],
      listen: false,
    });
    token = generateAlertSourceToken("alertmanager");
    updateConfig({ maxInvestigationsPerHour: 100 });
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    // Drain parked runs so a later test never inherits a live one. A released
    // finish re-parks while the finish gate pushes back, so release repeatedly.
    await settle();
    gate.releaseAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    updateConfig({ maxInvestigationsPerHour: 100 });
  });

  function ingest(
    body: ReturnType<typeof delivery>,
  ): Promise<{ stored: number; skipped: number }> {
    return nw.server
      .inject({
        method: "POST",
        url: "/api/alerts/ingest",
        headers: { "x-nightwarden-token": token },
        payload: body,
      })
      .then((res) => {
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body) as { stored: number; skipped: number };
      });
  }

  function liveSessions(): string[] {
    const { facts } = listSessionFacts(100, 0, "investigation");
    const live: string[] = [];
    for (const s of facts) {
      if (isRunning(s.sessionId)) live.push(s.sessionId);
    }
    return live;
  }

  function alertIdsOf(sessionId: string): string[] {
    return (getSession(sessionId)?.alerts ?? []).map(
      (entry) => entry.alert.sourceAlertId,
    );
  }

  // A released finish re-parks while the finish gate pushes back for a record, so
  // one release is not the end of a run - keep releasing until nothing is live.
  async function settle(): Promise<void> {
    for (let i = 0; i < 40 && liveSessions().length > 0; i++) {
      gate.releaseAll();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  // Relatedness is the alert source's decision, so two groups are two
  // incidents however close together they fire.
  it("two alerts in different groups, ten seconds apart, open two investigations", async () => {
    useGatedProvider();
    const before = countInvestigations();

    await ingest(delivery('{}:{alertname="Redis"}', [{ fingerprint: "r-1" }]));
    await waitFor(() => countInvestigations() === before + 1);

    await ingest(
      delivery('{}:{alertname="Payments"}', [
        { fingerprint: "p-1", container: "web-01" },
      ]),
    );
    await waitFor(() => countInvestigations() === before + 2);

    expect(liveSessions()).toHaveLength(2);
  });

  it("one delivery carrying three alerts opens one investigation covering all of them", async () => {
    useGatedProvider();
    const before = countInvestigations();

    const result = await ingest(
      delivery('{}:{alertname="Cascade"}', [
        { fingerprint: "c-1" },
        { fingerprint: "c-2" },
        { fingerprint: "c-3" },
      ]),
    );
    expect(result).toMatchObject({ stored: 3, skipped: 0 });

    await waitFor(() => countInvestigations() === before + 1);
    const [sessionId] = liveSessions();
    expect(alertIdsOf(sessionId!).sort()).toEqual(["c-1", "c-2", "c-3"]);
  });

  // Asserted through the opening turn, not the row: the count crosses four
  // layers and any one of them dropping it is the same defect.
  it("tells the agent how many alerts the sender left out of a delivery", async () => {
    useGatedProvider();
    const before = countInvestigations();
    const sent = scripted.requests.length;

    await ingest(
      delivery('{}:{alertname="Withheld"}', [{ fingerprint: "wh-1" }], 6),
    );
    await waitFor(() => countInvestigations() === before + 1);

    await waitFor(() => scripted.requests.length > sent);
    expect(messagesSentTo(scripted, sent)[0]?.texts.join("\n")).toContain(
      "left 6 further alerts out of this delivery",
    );
  });

  it("a new alert in a group already being investigated joins that run", async () => {
    useGatedProvider();
    const groupKey = '{}:{alertname="Joining"}';
    const before = countInvestigations();

    await ingest(delivery(groupKey, [{ fingerprint: "j-1" }]));
    await waitFor(() => countInvestigations() === before + 1);
    const [sessionId] = liveSessions();

    await ingest(delivery(groupKey, [{ fingerprint: "j-2" }]));

    // Same investigation, now covering both: no second row, and the alert is on
    // the session so resolution waits for it too.
    expect(countInvestigations()).toBe(before + 1);
    expect(alertIdsOf(sessionId!).sort()).toEqual(["j-1", "j-2"]);
  });

  // Alertmanager repeats a still-firing alert every few minutes. Scoped to the
  // run, this would reopen the identical alert every time one finished.
  it("a repeat of the same alert is dropped even after its investigation ended", async () => {
    expectDuplicateAlert();
    useImmediateProvider();
    const groupKey = '{}:{alertname="Repeating"}';
    const spec = { fingerprint: "rep-1", startsAt: "2026-07-07T03:00:00.000Z" };
    const before = countInvestigations();

    await ingest(delivery(groupKey, [spec]));
    await waitFor(() => countInvestigations() === before + 1);
    await waitFor(() => liveSessions().length === 0);

    const repeat = await ingest(delivery(groupKey, [spec]));
    expect(repeat).toMatchObject({ stored: 0, skipped: 1 });
    expect(countInvestigations()).toBe(before + 1);
  });

  it("the same alert firing again after it cleared is a new incident", async () => {
    useImmediateProvider();
    const groupKey = '{}:{alertname="Flapping"}';
    const before = countInvestigations();

    await ingest(
      delivery(groupKey, [
        { fingerprint: "f-1", startsAt: "2026-07-07T03:00:00.000Z" },
      ]),
    );
    await waitFor(() => countInvestigations() === before + 1);
    await waitFor(() => liveSessions().length === 0);
    markAlertCleared(
      "f-1",
      "2026-07-07T03:00:00.000Z",
      new Date().toISOString(),
    );

    // A different startsAt is a different incident, which is what the pairing of
    // fingerprint and fired-at is for.
    await ingest(
      delivery(groupKey, [
        { fingerprint: "f-1", startsAt: "2026-07-07T09:00:00.000Z" },
      ]),
    );
    await waitFor(() => countInvestigations() === before + 2);
  });

  /* A repeat leaves a broken run alone, so the recovery sweep is what tries
     again. Seeded rather than driven to failure, which is not what is tested. */
  function failedInvestigation(fingerprint: string): string {
    const sessionId = randomUUID();
    seedAlertSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      [
        {
          sourceAlertId: fingerprint,
          labels: {},
          alertType: "HighCPU",
          firedAt: "2026-07-07T03:00:00.000Z",
          annotations: {},
          generatorURL: null,
          values: {},
        },
      ],
    );
    appendErrorMessage(sessionId, "The provider had a server problem.");
    return sessionId;
  }

  describe("a run that failed while its alert kept firing", () => {
    it("is retried when the cause was worth waiting out", async () => {
      useGatedProvider();
      const sessionId = failedInvestigation("retry-1");
      recordRunFailure(sessionId, "transient");

      const pass = await reconcileRecovery(
        nw.dispatcher,
        Date.now() + 3_600_000,
      );
      expect(pass.retried).toBe(1);
      await settle();
    });

    it("stops after three attempts, however long the incident runs", async () => {
      useGatedProvider();
      const sessionId = failedInvestigation("retry-capped");
      // Three failures with nothing in between: the count is what is spent, not
      // the elapsed time, so no amount of further sweeping earns a fourth.
      for (let i = 0; i < 3; i++) recordRunFailure(sessionId, "transient");

      const pass = await reconcileRecovery(
        nw.dispatcher,
        Date.now() + 3_600_000,
      );
      expect(pass.retried).toBe(0);
    });

    it("is never retried when trying again cannot work", async () => {
      useGatedProvider();
      const sessionId = failedInvestigation("retry-2");

      // A rejected key, an empty account, a model that does not exist: each
      // fails identically every time, so retrying only writes more failures.
      recordRunFailure(sessionId, "permanent");
      const pass = await reconcileRecovery(
        nw.dispatcher,
        Date.now() + 3_600_000,
      );
      expect(pass.retried).toBe(0);
    });
  });

  describe("the hourly limit", () => {
    function investigations() {
      return listSessionFacts(500, 0, "investigation").facts;
    }

    // The harm the limit exists for: a storm of concurrent deliveries, every one
    // reading the hour's count at once, must not start more than it allows.
    it("starts no more than the limit from concurrent deliveries, and none owns no alert", async () => {
      useGatedProvider();
      const before = investigations();
      const started = before.filter((s) => s.status !== "not_started").length;
      updateConfig({ maxInvestigationsPerHour: started + 2 });

      const storm = ["a", "b", "c", "d", "e", "f"];
      const routed = await Promise.all(
        storm.map((id) =>
          ingest(
            delivery(`{}:{alertname="Storm-${id}"}`, [
              { fingerprint: `storm-${id}` },
            ]),
          ),
        ),
      );
      expect(routed.every((r) => r.stored === 1)).toBe(true);

      const known = new Set(before.map((s) => s.sessionId));
      const opened = investigations().filter((s) => !known.has(s.sessionId));
      expect(opened).toHaveLength(storm.length);
      expect(opened.every((s) => s.alerts.length === 1)).toBe(true);
      const held = opened.filter((s) => s.status === "not_started");
      expect(opened.length - held.length).toBe(2);
      expect(held[0]?.heldReason).toContain("Settings → Limits");
    });

    it("stores an alert delivered twice at once only once", async () => {
      expectDuplicateAlert();
      useGatedProvider();
      const twice = delivery('{}:{alertname="Twice"}', [
        { fingerprint: "tw-1" },
      ]);
      const routed = await Promise.all([ingest(twice), ingest(twice)]);

      expect(routed.map((r) => r.stored).sort((a, b) => a - b)).toEqual([0, 1]);
      const rows = investigations().flatMap((s) =>
        s.alerts.filter((entry) => entry.alert.sourceAlertId === "tw-1"),
      );
      expect(rows).toHaveLength(1);
    });

    it("Start runs a held investigation, and a held one whose alert clears reads as resolved", async () => {
      useGatedProvider();
      updateConfig({ maxInvestigationsPerHour: 1 });
      // Whatever this one does, the hour now holds at least one started run.
      await ingest(
        delivery('{}:{alertname="Filler"}', [{ fingerprint: "fl-1" }]),
      );
      await ingest(delivery('{}:{alertname="Held"}', [{ fingerprint: "h-1" }]));
      await ingest(
        delivery('{}:{alertname="Cleared"}', [{ fingerprint: "h-2" }]),
      );
      const heldIn = (id: string) =>
        investigations().find((s) =>
          s.alerts.some((entry) => entry.alert.sourceAlertId === id),
        );
      const held = heldIn("h-1");
      expect(held?.status).toBe("not_started");

      const start = () =>
        nw.server.inject({
          method: "POST",
          url: `/api/sessions/${held!.sessionId}/start`,
          headers: nw.headers,
        });
      expect((await start()).statusCode).toBe(202);
      expect(isRunning(held!.sessionId)).toBe(true);
      expect((await start()).statusCode).toBe(409);

      markAlertCleared(
        "h-2",
        "2026-07-07T03:00:00.000Z",
        new Date().toISOString(),
      );
      expect(heldIn("h-2")?.status).toBe("resolved");
    });
  });
});
