import { fakeModel } from "./fake-model.js";
import { randomUUID } from "node:crypto";
import {
  seedAlertSession,
  UNANSWERED_TURN,
  WHOLE_DELIVERY,
} from "./session-helper.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  NormalizedAlert,
  TranscriptRow,
  SessionMeta,
} from "@nightwarden/shared";
import { connectTestMetrics, useTempDb } from "./temp-db.js";
import {
  deleteMetricsSource,
  metricsSourceRow,
} from "../integrations/metrics/store.js";

import { admitDelivery, markAlertCleared } from "../session/alerts-store.js";
import { releaseRun } from "../session/status-store.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessionFacts,
} from "../session/store.js";
import {
  appendRowsAndPark,
  appendTranscriptRows,
  getTranscriptRows,
} from "../session/transcript-store.js";
import { listSessionPage } from "../session/list.js";
import { highestEvidenceNumber, resultParts } from "../agent/evidence-id.js";
import { recordFinding } from "../agent/report.js";
import { hasPendingHumanInput } from "../session/gate-store.js";
import { getRecord } from "../session/record-store.js";
import {
  seedCandidates,
  seedCompleteReport,
  seedRecommendation,
} from "./report-helper.js";
import { buildSeed } from "../session/seed.js";
import { buildTranscript } from "../session/transcript.js";
import {} from "../integrations/store.js";
import { verifyRecovery } from "../verification/recovery.js";
import { reconcileRecovery } from "../verification/reconciler.js";
import { dispatcherFor } from "../server.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: randomUUID(),
    title: "web-01 down",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function msg(
  sessionId: string,
  seq: number,
  overrides: Partial<TranscriptRow> = {},
): TranscriptRow {
  return {
    sessionId,
    seq,
    kind: seq % 2 === 0 ? "user" : "assistant",
    content: `message ${seq}`,
    parts: [{ type: "text", text: `message ${seq}` }],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const alert: NormalizedAlert = {
  sourceAlertId: "src-1",
  labels: {},
  alertName: "ContainerDown",
  firedAt: "2026-06-13T00:00:00.000Z",
  annotations: {},
  generatorURL: null,
  values: {},
};

// Its own identity each time: the store holds one row per alert still firing.
function firing(): NormalizedAlert {
  return { ...alert, sourceAlertId: randomUUID() };
}

describe("API-local session store", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("round-trips a session with the alert that opened it", () => {
    const m = meta();
    const opening = firing();
    seedAlertSession(m, [opening]);

    const stored = getSession(m.sessionId);
    expect(stored).toBeDefined();
    expect(stored?.title).toBe("web-01 down");
    // Not injected and nothing left out: this alert is what opened the session,
    // which is recorded rather than worked out from when it arrived.
    expect(stored?.alerts).toEqual([
      {
        alert: opening,
        arrivedAt: expect.any(String) as string,
        clearedAt: null,
        injected: false,
        droppedAlerts: 0,
        groupContext: null,
      },
    ]);
  });

  it("stores a chat session with no alerts at all", () => {
    const m = meta({ title: "hello" });
    createSession(m);

    expect(getSession(m.sessionId)?.alerts).toEqual([]);
  });

  it("keeps an alert that arrived after the session was already running", () => {
    const m = meta();
    const opening = firing();
    const later = { ...firing(), alertName: "HighLatency" };
    // Opened running, so the second delivery of its group joins it mid-run.
    admitDelivery(m, "grp-arrival", [opening], WHOLE_DELIVERY, Infinity);
    admitDelivery(m, "grp-arrival", [later], WHOLE_DELIVERY, Infinity);
    releaseRun(m.sessionId);

    const stored = getSession(m.sessionId)!.alerts;
    expect(stored.map((entry) => entry.alert)).toEqual([opening, later]);
    // Recorded, not deduced: both carry an arrival stamp and can land in the
    // same millisecond, so comparing them would read a race.
    expect(stored.map((entry) => entry.injected)).toEqual([false, true]);
    expect(stored[1]!.clearedAt).toBeNull();
  });

  it("createSession is idempotent and never clobbers the first title", () => {
    const m = meta({ title: "first" });
    const opening = firing();
    seedAlertSession(m, [opening]);
    createSession({ ...m, title: "second" });

    const stored = getSession(m.sessionId);
    expect(stored?.title).toBe("first");
    expect(stored?.alerts.map((entry) => entry.alert)).toEqual([opening]);
  });

  it("persists and reads back a transcript ordered by seq", () => {
    const m = meta();
    seedAlertSession(m, [firing()]);
    // Insert out of order to prove ordering is by seq, not insertion.
    appendTranscriptRows([msg(m.sessionId, 1), msg(m.sessionId, 0)]);
    appendTranscriptRows([msg(m.sessionId, 2)]);

    const transcript = getTranscriptRows(m.sessionId);
    expect(transcript.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(transcript[0].kind).toBe("user");
    expect(transcript[1].kind).toBe("assistant");
    expect(transcript[0].parts).toEqual([{ type: "text", text: "message 0" }]);
  });

  it("stamps each turn item with the timestamp of the row it came from", () => {
    const m = meta();
    seedAlertSession(m, [firing()]);
    const asked = "2026-06-13T00:05:00.000Z";
    const answered = "2026-06-13T00:06:30.000Z";
    appendTranscriptRows([
      { ...msg(m.sessionId, 0, { kind: "user" }), timestamp: asked },
      { ...msg(m.sessionId, 1, { kind: "assistant" }), timestamp: answered },
    ]);

    const items = buildTranscript(m.sessionId);
    // The run's span is read off these, so the RunGroup can say how long it took
    // on a transcript reloaded long after the clock that timed it live is gone.
    expect(items.find((i) => i.kind === "user_turn")).toMatchObject({
      timestamp: asked,
    });
    expect(items.find((i) => i.kind === "agent_text")).toMatchObject({
      timestamp: answered,
    });
  });

  it("replays a harness message to the model and draws it for nobody", () => {
    // The user did not write it, so it must not read as theirs, and a resume
    // that dropped it would leave the model's answer replying to nothing.
    const m = meta();
    seedAlertSession(m, [firing()]);
    appendTranscriptRows([
      msg(m.sessionId, 0),
      msg(m.sessionId, 1),
      msg(m.sessionId, 2, {
        kind: "system_reminder",
        content: "Your investigation record is not finished.",
        parts: [
          { type: "text", text: "Your investigation record is not finished." },
        ],
      }),
      msg(m.sessionId, 3),
    ]);

    const drawn = JSON.stringify(buildTranscript(m.sessionId));
    expect(drawn).not.toContain("Your investigation record");
    const items = buildTranscript(m.sessionId);
    // The alert that opened it, then the three turns; the harness turn is not one.
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: "alert_arrived", opening: true });

    // The seed speaks the provider's vocabulary, where there are two roles and
    // "harness" is not one of them: it goes back as the user turn it was.
    const seeded = buildSeed(m.sessionId);
    expect(seeded).toHaveLength(4);
    expect(seeded[2]).toMatchObject({
      role: "user",
      content: "Your investigation record is not finished.",
    });
  });

  it("keeps a failed tool call's own flag, and shows its result on the card", () => {
    // Recorded on the part, because no wire format carries it. Without it a
    // reload cannot tell a call that failed from one that answered.
    const m = meta();
    seedAlertSession(m, [firing()]);
    appendTranscriptRows([
      {
        ...msg(m.sessionId, 0, { kind: "assistant" }),
        parts: [
          { type: "tool_call", toolCallId: "tu-miss", name: "Read", input: {} },
          {
            type: "tool_result",
            toolCallId: "tu-miss",
            output: "not found",
            isError: true,
          },
        ],
      },
    ]);

    const answering = getTranscriptRows(m.sessionId)
      .flatMap((row) => row.parts)
      .find((p) => p.type === "tool_result" && p.toolCallId === "tu-miss");
    expect(answering).toMatchObject({ output: "not found", isError: true });

    const card = buildTranscript(m.sessionId).find(
      (item) => item.kind === "tool_call",
    );
    expect(card?.state).toEqual({
      phase: "complete",
      result: "not found",
      isError: true,
    });
  });

  it("rejects a duplicate (session_id, seq) so a hole can never be re-filled", () => {
    const m = meta();
    seedAlertSession(m, [firing()]);
    appendTranscriptRows([msg(m.sessionId, 0)]);

    expect(() => appendTranscriptRows([msg(m.sessionId, 0)])).toThrow();
  });

  it("appends a batch atomically: a duplicate in the batch rolls back the whole turn", () => {
    const m = meta();
    seedAlertSession(m, [firing()]);
    appendTranscriptRows([msg(m.sessionId, 0)]);

    // seq 1 is new, seq 0 collides; the batch must be all-or-nothing.
    expect(() =>
      appendTranscriptRows([msg(m.sessionId, 1), msg(m.sessionId, 0)]),
    ).toThrow();
    expect(getTranscriptRows(m.sessionId).map((t) => t.seq)).toEqual([0]);
  });

  it("lists sessions newest first", () => {
    const older = meta({
      title: "older",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = meta({
      title: "newer",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const other = meta({ title: "other" });
    seedAlertSession(older, [firing()]);
    seedAlertSession(newer, [firing()]);
    seedAlertSession(other, [firing()]);

    const list = listSessionFacts(100, 0, "investigation").facts.filter(
      (session) =>
        [other.sessionId, newer.sessionId, older.sessionId].includes(
          session.sessionId,
        ),
    );
    expect(list.map((s) => s.title)).toEqual(["other", "newer", "older"]);
  });

  describe("pagination", () => {
    // Distinct timestamps so the expected order is the one under test rather
    // than the id tiebreaker's.
    function seedSessions(count: number, prefix: string): void {
      for (let i = 0; i < count; i++) {
        seedAlertSession(
          meta({
            title: `${prefix}-${i}`,
            createdAt: `2026-03-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
          [firing()],
        );
      }
    }

    it("reaches sessions beyond the first page", () => {
      seedSessions(5, "page");

      const first = listSessionFacts(2, 0, "investigation");
      const second = listSessionFacts(
        2,
        first.nextOffset ?? 0,
        "investigation",
      );

      expect(first.facts).toHaveLength(2);
      expect(first.nextOffset).toBe(2);
      expect(second.facts).toHaveLength(2);
      // No row is served on both pages, which is what the id tiebreaker buys.
      const ids = [...first.facts, ...second.facts].map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("reports no next offset on the last page", () => {
      const only = listSessionFacts(1000, 0, "investigation");
      expect(only.nextOffset).toBeNull();
    });

    it("floats a session awaiting human input above newer activity", () => {
      const waiting = meta({
        title: "waiting",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      seedAlertSession(waiting, [firing()]);
      appendRowsAndPark(
        [msg(waiting.sessionId, 0)],
        {
          sessionId: waiting.sessionId,
          toolCallId: "tu-float",
          kind: "approval",
        },
        UNANSWERED_TURN,
      );
      seedAlertSession(meta({ title: "newer than waiting" }), [firing()]);

      const first = listSessionFacts(1, 0, "investigation");
      expect(first.facts[0].sessionId).toBe(waiting.sessionId);
      expect(first.facts[0].awaitingHumanInput).toBe(true);
    });
  });

  it("returns undefined for an unknown session", () => {
    expect(getSession("nope")).toBeUndefined();
    expect(getTranscriptRows("nope")).toEqual([]);
  });

  it("deleteSession removes the session, its messages, and any pending interrupt", () => {
    const m = meta();
    seedAlertSession(m, [firing()]);
    appendRowsAndPark(
      [msg(m.sessionId, 0)],
      {
        sessionId: m.sessionId,
        toolCallId: "tu-del-1",
        kind: "approval",
      },
      UNANSWERED_TURN,
    );

    deleteSession(m.sessionId);

    expect(getSession(m.sessionId)).toBeUndefined();
    expect(getTranscriptRows(m.sessionId)).toEqual([]);
    expect(hasPendingHumanInput(m.sessionId)).toBe(false);
  });

  it("deleteSession on an unknown session is a no-op", () => {
    expect(deleteSession("nope")).toBeUndefined();
  });

  it("deleteSession removes the report (it has no reason to outlive the session)", () => {
    const m = meta();
    seedAlertSession(m, [firing()]);
    seedCompleteReport(m.sessionId);
    expect(getRecord(m.sessionId)).toBeDefined();

    deleteSession(m.sessionId);

    expect(getRecord(m.sessionId)).toBeUndefined();
  });

  it("rejects a transcript message for a session that does not exist (foreign keys enforced)", () => {
    expect(() => appendTranscriptRows([msg("ghost-session", 0)])).toThrow(
      /FOREIGN KEY/i,
    );
  });

  // The five words and nothing else. Every one of them is derived from the
  // action log, the alert or the hypothesis rows; none is ever declared.
  describe("derived status", () => {
    /* A citation is an evidence id the model was issued, so a test handing a raw
       tool_use id describes something production refuses. */
    function seedCitedCall(sessionId: string): string {
      appendTranscriptRows([
        {
          ...msg(sessionId, 0, { kind: "assistant" }),
          parts: [
            {
              type: "tool_call",
              toolCallId: "tu-seed",
              name: "Read",
              input: {},
            },
            { type: "tool_result", toolCallId: "tu-seed", output: "ok" },
          ],
        },
      ]);
      return "e1";
    }

    function statusOf(sessionId: string): string | null {
      const row = listSessionPage(200, 0, "investigation").rows.find(
        (r) => r.sessionId === sessionId,
      );
      return row?.status ?? null;
    }

    // Its own alert id per session: clearing one must not settle another's.
    function investigation(sourceAlertId = randomUUID()): string {
      const m = meta();
      seedAlertSession(m, [{ ...alert, sourceAlertId }]);
      return m.sessionId;
    }

    it("says nothing about a session that is not under investigation", () => {
      const m = meta();
      createSession(m);
      expect(statusOf(m.sessionId)).toBeNull();
    });

    // A write is evidence of effort, not outcome. The alert that fired is the
    // only thing that can say the incident is over.
    it("does not resolve on a write while the alert it fired on still fires", () => {
      const sessionId = investigation();
      seedCompleteReport(sessionId);
      appendTranscriptRows([
        {
          sessionId,
          seq: 0,
          kind: "assistant",
          content: "",
          parts: [
            {
              type: "tool_call",
              toolCallId: "tu-exec",
              name: "RestartDockerService",
              input: { target: "prod-1/app/web" },
            },
            { type: "tool_result", toolCallId: "tu-exec", output: "ok" },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);
      expect(statusOf(sessionId)).toBe("completed");
    });

    // No alert means no condition, and no condition means nothing can say the
    // incident is over, so it never reads Resolved.
    it("never resolves a session that fired on no alert", () => {
      const m = meta();
      createSession(m, true);
      seedCompleteReport(m.sessionId);
      expect(statusOf(m.sessionId)).toBe("completed");
    });

    it("reads Resolved when the alert cleared, with nothing run", () => {
      const sourceAlertId = randomUUID();
      const sessionId = investigation(sourceAlertId);
      const untouched = investigation();
      seedCompleteReport(sessionId);
      seedCompleteReport(untouched);
      expect(statusOf(sessionId)).toBe("completed");

      // The ids it answers with are what ingest publishes REPORT_UPDATED for, so
      // it names the sessions actually holding the alert, and each of them once.
      expect(
        markAlertCleared(
          sourceAlertId,
          alert.firedAt,
          new Date().toISOString(),
        ),
      ).toEqual([sessionId]);
      expect(statusOf(sessionId)).toBe("resolved");
      expect(statusOf(untouched)).toBe("completed");
    });

    /* A fingerprint hashes the labels, so the same condition firing months later
       carries the same one. Clearing the new firing must not close the old. */
    it("clears the firing it names, not an older one sharing its fingerprint", () => {
      const sourceAlertId = randomUUID();
      const january = meta();
      seedAlertSession(january, [
        { ...alert, sourceAlertId, firedAt: "2026-01-03T02:00:00.000Z" },
      ]);
      const august = meta();
      seedAlertSession(august, [
        { ...alert, sourceAlertId, firedAt: "2026-08-12T14:00:00.000Z" },
      ]);
      seedCompleteReport(january.sessionId);
      seedCompleteReport(august.sessionId);

      expect(
        markAlertCleared(
          sourceAlertId,
          "2026-08-12T14:00:00.000Z",
          new Date().toISOString(),
        ),
      ).toEqual([august.sessionId]);
      expect(statusOf(august.sessionId)).toBe("resolved");
      // January never recovered, and August recovering says nothing about it.
      expect(statusOf(january.sessionId)).toBe("completed");
    });

    it("stays unresolved until every alert of a batch has cleared", () => {
      // A batch elects no primary, so one symptom recovering while the others
      // still fire is not the incident being over.
      const m = meta();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      seedAlertSession(
        m,
        ids.map((sourceAlertId) => ({ ...alert, sourceAlertId })),
      );
      seedCompleteReport(m.sessionId);

      markAlertCleared(ids[0]!, alert.firedAt, new Date().toISOString());
      expect(statusOf(m.sessionId)).toBe("completed");
      markAlertCleared(ids[1]!, alert.firedAt, new Date().toISOString());
      expect(statusOf(m.sessionId)).toBe("completed");

      markAlertCleared(ids[2]!, alert.firedAt, new Date().toISOString());
      expect(statusOf(m.sessionId)).toBe("resolved");
    });

    it("reads Failed when the run crashed rather than stood down", () => {
      const sessionId = investigation();
      appendTranscriptRows([msg(sessionId, 0, { kind: "error" })]);
      expect(statusOf(sessionId)).toBe("failed");
    });

    /* Status reads no part of the record, so every finished run reads the same
       word. A recommendation is not a gate, since nothing marks one as acted on. */
    it("reads Completed for a finished run, whatever its record holds", () => {
      const recommended = investigation();
      seedCompleteReport(recommended);
      seedRecommendation(recommended, "restart the container");
      expect(statusOf(recommended)).toBe("completed");

      const ruledOut = investigation();
      seedCompleteReport(ruledOut);
      expect(statusOf(ruledOut)).toBe("completed");

      const named = investigation();
      recordFinding(named, {
        verdict: "trigger",
        candidate: seedCandidates(named)[0]!,
        explanation: "the climb starts at the merge",
        evidenceIds: [seedCitedCall(named)],
      });
      expect(statusOf(named)).toBe("completed");

      // Recording nothing at all is the same answer, honestly stated.
      expect(statusOf(investigation())).toBe("completed");
    });

    /* Verification asks whoever owns the condition, never the model, and writes
       the same clearedAt the resolved webhook does. */
    describe("verifying the condition against its own source", () => {
      function rulesAnswer(alerts: unknown[]): void {
        vi.stubGlobal(
          "fetch",
          vi.fn(() =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  status: "success",
                  data: {
                    groups: [
                      {
                        rules: [
                          { name: alert.alertName, type: "alerting", alerts },
                        ],
                      },
                    ],
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            ),
          ),
        );
      }

      // An alert as a real webhook delivers it: the rule's own series labels
      // plus the external_labels Prometheus attaches on the way to Alertmanager.
      function labelledInvestigation(labels: Record<string, string>): string {
        const m = meta();
        seedAlertSession(m, [
          { ...alert, sourceAlertId: randomUUID(), labels },
        ]);
        return m.sessionId;
      }

      beforeEach(() => {
        connectTestMetrics({
          queryUrl: "http://prom.test",
          rulesUrl: "http://prom.test",
        });
      });

      afterEach(() => {
        vi.unstubAllGlobals();
        deleteMetricsSource();
      });

      it("resolves once the rules API no longer holds the rule firing", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);
        expect(statusOf(sessionId)).toBe("completed");

        rulesAnswer([]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("confirmed");
        // Written to the same field the webhook writes, so the two ways of
        // learning it converge on one record and status stays a plain read.
        expect(statusOf(sessionId)).toBe("resolved");
      });

      // A fix lands, the rule's `for:` elapses, and the alert goes quiet minutes
      // after the run ended. The finish gate cannot hear that; the sweep can.
      it("resolves after the run ended, with no webhook, when the sweep next asks", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);
        expect(statusOf(sessionId)).toBe("completed");

        rulesAnswer([]);
        await reconcileRecovery(dispatcherFor(fakeModel().modelFor));

        expect(statusOf(sessionId)).toBe("resolved");
      });

      it("leaves a still-firing rule alone", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);

        rulesAnswer([{ state: "firing", labels: {} }]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(statusOf(sessionId)).toBe("completed");
      });

      // The rule is true but has not held long enough to fire. Reading that as
      // recovery would resolve an incident on its way back.
      it("does not call a pending rule recovered", async () => {
        const sessionId = investigation();
        rulesAnswer([{ state: "pending", labels: {} }]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
      });

      // external_labels ride to Alertmanager but never reach rule evaluation, so
      // a firing rule must not resolve however far the two label sets differ.
      it("never resolves an alert carrying labels the rules API cannot have", async () => {
        const sessionId = labelledInvestigation({
          alertname: "ContainerDown",
          container: "payments-api",
          cluster: "prod-eu",
          monitor: "primary",
        });
        seedCompleteReport(sessionId);

        rulesAnswer([
          {
            state: "firing",
            labels: {
              alertname: "ContainerDown",
              severity: "critical",
              container: "payments-api",
            },
          },
        ]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(statusOf(sessionId)).toBe("completed");
      });

      // An unanswerable question is not a yes. Collapse this into "confirmed"
      // and an unreachable Prometheus silently resolves every open incident.
      it("never reads an unreachable source as recovery", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);

        vi.stubGlobal(
          "fetch",
          vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
        );
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(statusOf(sessionId)).toBe("completed");
        expect(metricsSourceRow()?.rejection).toBeNull();
      });

      // A revoked rules credential would otherwise leave every incident open in silence.
      it("records a refused rules credential on the metrics source", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);

        vi.stubGlobal(
          "fetch",
          vi.fn(() => Promise.resolve(new Response("denied", { status: 401 }))),
        );
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(metricsSourceRow()?.rejection?.reason).toContain(
          "rejected the credential",
        );
      });

      it("never reads a rule Prometheus does not know as recovery", async () => {
        const sessionId = investigation();
        rulesAnswer([]);
        // Answering about some other rule is not answering about this one.
        vi.stubGlobal(
          "fetch",
          vi.fn(() =>
            Promise.resolve(
              new Response(
                JSON.stringify({ status: "success", data: { groups: [] } }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            ),
          ),
        );
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(statusOf(sessionId)).toBe("completed");
      });

      it("has nothing to verify on a session no alert opened", async () => {
        const m = meta();
        createSession(m, true);
        await expect(verifyRecovery(m.sessionId)).resolves.toBe("no_condition");
      });
    });

    it("gives every investigation a group, whatever its record holds", () => {
      const sessionId = investigation();
      recordFinding(sessionId, {
        verdict: "symptom",
        candidate: seedCandidates(sessionId)[0]!,
        explanation: "it followed the upstream failure",
        evidenceIds: [seedCitedCall(sessionId)],
      });
      const rows = listSessionPage(500, 0, "investigation").rows.filter(
        (r) => r.investigation,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status !== null)).toBe(true);
      expect(
        rows.find((r) => r.sessionId === sessionId)?.status,
      ).not.toBeNull();
    });
  });

  // The line answers the question its status raises, so the list can be triaged
  // without opening every row. Every branch is a record or the model's prose.
  describe("the status line", () => {
    // Both kinds, because these cases cover a chat as well as an investigation
    // and the list is now served one kind at a time.
    function rowOf(sessionId: string) {
      const pages = [
        listSessionPage(500, 0, "investigation"),
        listSessionPage(500, 0, "chat"),
      ];
      return pages
        .flatMap((page) => page.rows)
        .find((r) => r.sessionId === sessionId);
    }
    function statusLineOf(sessionId: string): string | null | undefined {
      return rowOf(sessionId)?.statusLine;
    }
    function investigation(sourceAlertId = randomUUID()): string {
      const m = meta();
      seedAlertSession(m, [{ ...alert, sourceAlertId }]);
      return m.sessionId;
    }

    // A citation survives only if the call it names is in the transcript, and
    // is stamped as the loop stamps it, so the handle returned is the stored one.
    function cite(sessionId: string, toolCallId: string, seq: number): string {
      const from = highestEvidenceNumber(getTranscriptRows(sessionId)) + 1;
      const { parts } = resultParts(
        [{ toolCallId, content: "ok" }],
        new Set([toolCallId]),
        from,
      );
      appendTranscriptRows([
        {
          ...msg(sessionId, seq, { kind: "assistant" }),
          parts: [
            { type: "tool_call", toolCallId, name: "Read", input: {} },
            ...parts,
          ],
        },
      ]);
      return `e${from}`;
    }

    it("says what a gated session waits on, by the kind of answer it needs", () => {
      const sessionId = investigation();
      appendRowsAndPark(
        [msg(sessionId, 0)],
        {
          sessionId,
          toolCallId: "tu-gate",
          kind: "approval",
        },
        UNANSWERED_TURN,
      );
      expect(statusLineOf(sessionId)).toBe("Waiting on approval");
    });

    it("names the fix a finished run is waiting on somebody to take", () => {
      const sessionId = investigation();
      seedCompleteReport(sessionId);
      seedRecommendation(sessionId, "raise the pod memory limit to 2Gi");
      expect(statusLineOf(sessionId)).toBe("raise the pod memory limit to 2Gi");
    });

    // With no fix written the claim stands in for one, and the claim that leads
    // is the most confident the run reached, not the last thing it typed.
    it("leads with the most confident claim, the newer of two equals winning", () => {
      const sessionId = investigation();
      recordFinding(sessionId, {
        verdict: "symptom",
        candidate: seedCandidates(sessionId, 1, [
          "memory climbs with the cache",
        ])[0]!,
        explanation: "it climbs with the cache",
        evidenceIds: [cite(sessionId, "tu-1", 0)],
      });
      recordFinding(sessionId, {
        verdict: "root_cause",
        candidate: seedCandidates(sessionId, 1, [
          "the sidecar leaks between deploys",
        ])[0]!,
        explanation: "the leak survives the restart",
        evidenceIds: [cite(sessionId, "tu-2", 1)],
      });
      // The cause outranks the symptom even though the symptom settled first.
      expect(statusLineOf(sessionId)).toBe("the sidecar leaks between deploys");

      recordFinding(sessionId, {
        verdict: "root_cause",
        candidate: seedCandidates(sessionId, 1, [
          "the pool never returns its connections",
        ])[0]!,
        explanation: "the pool is full at the crash",
        evidenceIds: [cite(sessionId, "tu-3", 2)],
      });
      expect(statusLineOf(sessionId)).toBe(
        "the pool never returns its connections",
      );
    });

    it("says the condition recovered, never which fix ran", () => {
      const sourceAlertId = randomUUID();
      const sessionId = investigation(sourceAlertId);
      seedCompleteReport(sessionId);
      markAlertCleared(sourceAlertId, alert.firedAt, new Date().toISOString());
      expect(statusLineOf(sessionId)).toBe("Alert condition recovered");
    });

    it("names what a completed run ruled out, and nothing when it recorded nothing", () => {
      const ruled = investigation();
      seedCompleteReport(ruled); // one disproven hypothesis
      expect(statusLineOf(ruled)).toBe("Ruled out: seeded by test");
      expect(statusLineOf(investigation())).toBeNull();
    });

    it("gives a failed run its own error text", () => {
      const sessionId = investigation();
      appendTranscriptRows([
        msg(sessionId, 0, { kind: "error", content: "the provider timed out" }),
      ]);
      expect(statusLineOf(sessionId)).toBe("the provider timed out");
    });

    it("leaves a session that is not under investigation with no finding", () => {
      const m = meta();
      createSession(m);
      expect(statusLineOf(m.sessionId)).toBeNull();
    });

    // The rank orders rows; the label is what the user wrote and is the
    // only thing rendered.
    it("carries the severity rank and the label's own word apart", () => {
      const m = meta();
      seedAlertSession(m, [
        {
          ...alert,
          sourceAlertId: randomUUID(),
          labels: { severity: "P1" },
        },
      ]);
      expect(rowOf(m.sessionId)).toMatchObject({
        severityLabel: "P1",
      });
    });
  });

  // Claims about every session, which a page of rows cannot answer: a count of
  // loaded pages climbs as the user scrolls and reads zero before they do.
  describe("the page's total and its filters", () => {
    function investigation(title?: string): string {
      const m = meta(title === undefined ? {} : { title });
      seedAlertSession(m, [{ ...alert, sourceAlertId: randomUUID() }]);
      return m.sessionId;
    }

    // One of each: parked on a person, recovered, and finished without recovery.
    function oneOfEach(): Record<string, string> {
      const waiting = investigation();
      appendRowsAndPark(
        [msg(waiting, 0)],
        {
          sessionId: waiting,
          toolCallId: `tu-${waiting}`,
          kind: "approval",
        },
        UNANSWERED_TURN,
      );
      const sourceAlertId = randomUUID();
      const resolved = meta();
      seedAlertSession(resolved, [{ ...alert, sourceAlertId }]);
      seedCompleteReport(resolved.sessionId);
      markAlertCleared(sourceAlertId, alert.firedAt, new Date().toISOString());
      const completed = investigation();
      seedCompleteReport(completed);
      return { waiting, resolved: resolved.sessionId, completed };
    }

    it("lists only the rows a filter gathers", () => {
      const ids = oneOfEach();
      // Active is what is still in play: a run working, or one waiting on a person.
      const active = listSessionPage(500, 0, "investigation", {
        status: "active",
      });
      expect(
        active.rows.every((r) =>
          ["action_required", "running"].includes(r.status ?? ""),
        ),
      ).toBe(true);
      expect(active.rows.map((r) => r.sessionId)).toContain(ids.waiting);

      const resolved = listSessionPage(500, 0, "investigation", {
        status: "resolved",
      });
      expect(resolved.rows.every((r) => r.status === "resolved")).toBe(true);
      expect(resolved.rows.map((r) => r.sessionId)).toContain(ids.resolved);

      const closed = listSessionPage(500, 0, "investigation", {
        status: "closed",
      });
      expect(
        closed.rows.every((r) =>
          ["completed", "stopped", "failed"].includes(r.status ?? ""),
        ),
      ).toBe(true);
      expect(closed.rows.map((r) => r.sessionId)).toContain(ids.completed);
      expect(closed.rows.map((r) => r.sessionId)).not.toContain(ids.waiting);
    });

    // A person types % or _ meaning the character, never a wildcard.
    it("searches titles for the typed text, whatever its case", () => {
      const full = investigation("Disk 100% on web_01");
      const near = investigation("Disk 1000 on webX01");
      const found = (q: string): string[] =>
        listSessionPage(500, 0, "investigation", { q }).rows.map(
          (r) => r.sessionId,
        );

      expect(found("100%")).toContain(full);
      expect(found("100%")).not.toContain(near);
      expect(found("web_01")).not.toContain(near);
      expect(found("disk 100% ON")).toContain(full);
      // Blank is no search at all.
      expect(found("")).toEqual(expect.arrayContaining([full, near]));
    });

    it("totals every investigation, so a record's place in the queue is true", () => {
      const before = listSessionPage(1, 0, "investigation").investigationTotal;
      investigation();
      createSession(meta()); // a chat adds nothing to the total
      expect(listSessionPage(1, 0, "investigation").investigationTotal).toBe(
        before + 1,
      );
    });

    it("filters the rows by kind, leaving the total alone", () => {
      const chat = meta();
      createSession(chat);
      const only = listSessionPage(500, 0, "investigation");
      expect(only.rows.every((r) => r.investigation)).toBe(true);
      expect(only.rows.some((r) => r.sessionId === chat.sessionId)).toBe(false);

      const chats = listSessionPage(500, 0, "chat");
      expect(chats.rows.every((r) => !r.investigation)).toBe(true);
      expect(chats.rows.some((r) => r.sessionId === chat.sessionId)).toBe(true);
      expect(chats.investigationTotal).toBe(only.investigationTotal);
    });
  });
});
