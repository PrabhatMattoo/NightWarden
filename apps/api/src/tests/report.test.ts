import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { type NormalizedAlert, type TranscriptRow } from "@nightwarden/shared";
import {
  runSession,
  type RunOutcome,
  type RunSessionInput,
} from "../agent/loop/run-session.js";
import {
  gatedCalls,
  isCitable,
  recordGaps,
  resolveEvidence,
  toolCallsIn,
} from "../agent/report.js";
import { REPORT_TOOLS, COMPOSE_REPORT_TOOL } from "../agent/tools/report.js";
import { buildSeed } from "../session/seed.js";
import { executeTool } from "../agent/tools/toolset.js";
import { getRecord } from "../session/record-store.js";
import {
  messagePartsToText,
  principalFindings,
  supersededIds,
} from "@nightwarden/shared";
import type { MessagePart, ReminderKind } from "@nightwarden/shared";
import {
  appendTranscriptRows,
  getNextSeq,
  getTranscriptRows,
} from "../session/transcript-store.js";
import { highestEvidenceNumber, resultParts } from "../agent/evidence-id.js";
import { buildSessionMeta } from "../agent/loop/run-session.js";
import { seedAlertSession, seedChatSession } from "./session-helper.js";
import { seedCandidates, seedCompleteReport } from "./report-helper.js";
import { createRunner } from "../fleet/runners-store.js";
import { buildTranscript } from "../session/transcript.js";
import { fakeModel, messagesSentTo, type ScriptedTurn } from "./fake-model.js";
import { fakeRunner, type HarnessRunner } from "./harness.js";
import { manifest } from "./manifest-helper.js";
import { useTempDb } from "./temp-db.js";

const wire = fakeModel();
// Where each of the current test's runs began, in the provider's requests.
const runs: number[] = [];

async function run(input: RunSessionInput): Promise<RunOutcome> {
  runs.push(wire.requests.length);
  return await runSession(input, wire.modelFor);
}

// How many requests one of the test's runs made.
function requestsOf(index: number): number {
  return (runs[index + 1] ?? wire.requests.length) - (runs[index] ?? 0);
}

function alert(sourceAlertId: string): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    alertType: "HighMemory",
    firedAt: new Date().toISOString(),
    annotations: {},
    generatorURL: null,
    values: {},
  };
}

describe("the investigation record", () => {
  // A read only answers if a runner is there to answer it, and a call that
  // failed is issued no handle, so a fixture without one cites nothing.
  function connectRunner(): HarnessRunner {
    return fakeRunner({
      id: createRunner("docker", "rc-host").id,
      name: "rc-host",
      manifest: manifest("rc-host"),
    });
  }

  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
  });

  beforeEach(() => {
    runs.length = 0;
    wire.script([]);
  });

  const METRICS = JSON.stringify({
    resultType: "matrix",
    series: [
      {
        metric: { __name__: "container_memory_rss", container: "web-01" },
        values: [
          [1720000000, "100"],
          [1720000060, "200"],
        ],
      },
    ],
    windowStart: "2026-07-03T00:00:00.000Z",
    windowEnd: "2026-07-03T03:00:00.000Z",
    stepSeconds: 60,
  });

  const CHANGES = JSON.stringify({
    branch: "main",
    windowStart: "2026-07-03T00:00:00.000Z",
    windowEnd: "2026-07-04T00:00:00.000Z",
    pullRequests: [
      {
        number: 482,
        title: "bump cache size",
        author: "dev",
        mergedAt: "2026-07-03T01:00:00.000Z",
        url: "https://github.com/o/r/pull/482",
      },
    ],
    commits: [],
  });

  // Stamped as the loop stamps it, on the answer rather than the request.
  function appendCitableRows(rows: TranscriptRow[]): void {
    const sessionId = rows[0]!.sessionId;
    const stored = getTranscriptRows(sessionId);
    let next = highestEvidenceNumber(stored) + 1;
    const citable = new Set(
      [...stored, ...rows]
        .flatMap((row) => row.parts)
        .flatMap((part) =>
          part.type === "tool_call" && isCitable(part.name)
            ? [part.toolCallId]
            : [],
        ),
    );
    const stamped = rows.map((row) => {
      const answers = row.parts.flatMap((part) =>
        part.type === "tool_result" ? [part] : [],
      );
      if (answers.length === 0) return row;
      const issued = resultParts(
        answers.map((part) => ({
          toolCallId: part.toolCallId,
          content: part.output,
          ...(part.isError === true && { isError: true as const }),
        })),
        citable,
        next,
      );
      next = issued.next;
      const byId = new Map(issued.parts.map((part) => [part.toolCallId, part]));
      return {
        ...row,
        parts: row.parts.map((part) =>
          part.type === "tool_result"
            ? (byId.get(part.toolCallId) ?? part)
            : part,
        ),
      };
    });
    appendTranscriptRows(stamped);
  }

  // One record entry at a chosen instant, so a read after a remediation is
  // distinguishable from one before. The parts carry what production carries.
  function appendCall(
    sessionId: string,
    seq: number,
    entry: { toolCallId: string; name: string; input: Record<string, unknown> },
    output: string,
    at: string,
    isError?: true,
    approved?: boolean,
    actor?: { id: string; name: string; email: string },
  ): void {
    // Stamped as the loop stamps it, so a call here is citable exactly when a
    // call in a real run would be.
    appendCitableRows([
      {
        sessionId,
        seq,
        kind: "assistant",
        content: `[tool: ${entry.name}]`,
        parts: [
          {
            type: "tool_call",
            toolCallId: entry.toolCallId,
            name: entry.name,
            input: entry.input,
          },
        ],
        timestamp: at,
      },
      {
        sessionId,
        seq: seq + 1,
        kind: "user",
        content: "results",
        parts: [
          {
            type: "tool_result",
            toolCallId: entry.toolCallId,
            output,
            ...(isError === true && { isError: true }),
          },
          ...(approved === undefined
            ? []
            : [
                {
                  type: "tool_approval" as const,
                  toolCallId: entry.toolCallId,
                  approved,
                  ...(actor !== undefined && { actor }),
                },
              ]),
        ],
        timestamp: at,
      },
    ]);
  }

  // tu-1 a Prometheus range query, tu-2 a GitHub change list: two sources, so
  // citing both is corroboration and citing either alone is not.
  function seedTranscript(sessionId: string): void {
    seedAlertSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      [alert("seed")],
    );
    appendCall(
      sessionId,
      0,
      {
        toolCallId: "tu-1",
        name: "QueryMetricsRange",
        input: { query: "rss" },
      },
      METRICS,
      "2026-07-03T02:00:00.000Z",
    );
    appendCall(
      sessionId,
      2,
      { toolCallId: "tu-2", name: "ListRecentGitChanges", input: {} },
      CHANGES,
      "2026-07-03T02:01:00.000Z",
    );
    // Findings settle candidates, so the record every case records into has two.
    seedCandidates(sessionId, 2);
  }

  // Written down before it runs, as the loop writes it, so a refusal here reads
  // the same transcript a refusal in a real run reads.
  async function call(
    toolName: string,
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<{ content: unknown; isError?: true }> {
    const toolCallId = `tu-${toolName}-${randomUUID()}`;
    appendCitableRows([
      {
        sessionId,
        seq: getNextSeq(sessionId),
        kind: "assistant",
        content: `[tool: ${toolName}]`,
        parts: [
          { type: "tool_call", toolCallId: toolCallId, name: toolName, input },
        ],
        timestamp: new Date().toISOString(),
      },
    ]);
    const tool = REPORT_TOOLS.find((t) => t.schema.name === toolName);
    return await executeTool(tool!, input, {
      sessionId,
      toolCallId,
      toolCallCeilingMs: 15_000,
    });
  }

  // Records a tested finding and returns the id the system assigned to it.
  async function record(
    sessionId: string,
    verdict: string,
    evidenceIds: string[],
    explanation = "",
    candidate = "c1",
  ): Promise<string> {
    await call("RecordFinding", sessionId, {
      verdict,
      explanation,
      evidenceIds,
      candidate,
    });
    const findings = getRecord(sessionId)!.findings;
    return findings[findings.length - 1]!.id;
  }

  // Every field is required, so a case about one blank field overrides that
  // field and takes the rest from here.
  async function submit(
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<{ content: unknown; isError?: true }> {
    const complete = {
      headline: "the cache bump raised the memory floor",
      affected: "web-01",
      impact: "nine minutes of failed reads",
      recommendation: "revert PR #482",
      ...input,
    };
    return await executeTool(COMPOSE_REPORT_TOOL, complete, {
      sessionId,
      toolCallId: "tu-submit",
      toolCallCeilingMs: 15_000,
    });
  }

  describe("recording a hypothesis", () => {
    it("records what was tested and how it settled as one act", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);

      const id = await record(
        sessionId,
        "root_cause",
        ["e1"],
        "the climb starts at the merge",
      );
      const stored = getRecord(sessionId)!.findings[0]!;
      expect(stored).toMatchObject({
        id,
        verdict: "root_cause",
        explanation: "the climb starts at the merge",
        candidate: "c1",
        evidenceIds: ["e1"],
      });
      expect(stored.recordedAt).not.toBe("");
    });

    it("expresses all five verdicts, every one of them settled", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const verdicts = [
        "root_cause",
        "trigger",
        "symptom",
        "contributing_factor",
        "disproven",
      ];
      for (const verdict of verdicts) {
        await record(sessionId, verdict, ["e1"]);
      }
      expect(getRecord(sessionId)!.findings.map((h) => h.verdict)).toEqual(
        verdicts,
      );
    });

    it("refuses a verdict that is not one of the five", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const result = await call("RecordFinding", sessionId, {
        verdict: "open",
        explanation: "still looking",
        candidate: "c1",
        evidenceIds: ["e1"],
      });
      expect(result.isError).toBe(true);
      expect(getRecord(sessionId)!.findings).toHaveLength(0);
    });

    it("refuses a claim with nothing behind it, unless it is untestable", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      seedCandidates(sessionId, 3);
      let cand = 0;
      for (const verdict of ["root_cause", "disproven"]) {
        const result = await call("RecordFinding", sessionId, {
          verdict,
          candidate: `c${++cand}`,
          explanation: "no reason given",
          evidenceIds: [],
        });
        expect(result.isError).toBe(true);
        expect(String(result.content)).toContain("at least one citation");
      }
      // Untestable is the one verdict that may cite nothing: it means no tool
      // could reach the candidate, so there is no result to point at.
      const untestable = await call("RecordFinding", sessionId, {
        verdict: "untestable",
        candidate: "c3",
        explanation: "no tool reaches it",
        evidenceIds: [],
      });
      expect(untestable.isError).toBeFalsy();
      expect(getRecord(sessionId)!.findings).toHaveLength(1);
    });

    /* Append-only: there is no call that rewrites a row, so a changed mind is a
       second record beside the first rather than an edit of it. */
    it("keeps a claim the run later disagreed with beside the one that replaced it", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "root_cause", ["e1"]);
      await record(sessionId, "disproven", ["e2"]);

      expect(
        getRecord(sessionId)!.findings.map((h) => [h.id, h.verdict]),
      ).toEqual([
        ["f1", "root_cause"],
        ["f2", "disproven"],
      ]);
    });

    /* Position within one candidate is the link, so the run states what it now
       stands behind without naming a row it has to remember. */
    it("lets a later claim about one candidate replace the earlier one", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "root_cause", ["e1"]);
      await record(sessionId, "root_cause", ["e2"]);

      const { findings } = getRecord(sessionId)!;
      expect(findings).toHaveLength(2);
      // Both stand on the record; only the second can lead.
      expect(principalFindings(findings)[0]!.id).toBe("f2");
      expect(supersededIds(findings)).toEqual(new Set(["f1"]));
    });

    it("refuses a claim naming a candidate that does not exist", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const result = await call("RecordFinding", sessionId, {
        verdict: "root_cause",
        explanation: "",
        evidenceIds: ["e1"],
        candidate: "c9",
      });

      // Nothing is recorded, and the ids it may use are named back to it.
      expect(getRecord(sessionId)!.findings).toHaveLength(0);
      expect(String(result.content)).toContain("c9 is not a candidate");
      expect(String(result.content)).toContain("c1");
    });

    /* All of them or none: keeping the half that resolved would change the claim
       the model made, and drop it from corroborated to cited without saying so. */
    it("refuses a claim citing one real call and one that names nothing", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const refused = await call("RecordFinding", sessionId, {
        verdict: "root_cause",
        explanation: "",
        candidate: "c1",
        evidenceIds: ["e1", "e9"],
      });

      expect(getRecord(sessionId)!.findings).toHaveLength(0);
      // Told which one failed, and the range it could have picked from.
      expect(String(refused.content)).toContain("e9");
      expect(String(refused.content)).toContain("e1 through e2");
    });
  });

  describe("the written report", () => {
    it("writes the prose the record has no field for, over a record it leaves alone", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "root_cause", ["e1"]);

      await submit(sessionId, {
        summary:
          "web-01 was OOM-killed because the cache bump raised its floor",
        timeline: [
          {
            at: "2026-07-03T01:00:00.000Z",
            what: "PR #482 merged",
            evidenceId: "e2",
          },
        ],
        impact: "nine minutes of failed reads",
        recommendation: "revert PR #482",
      });

      const written = getRecord(sessionId)!;
      expect(written.report).toMatchObject({
        summary:
          "web-01 was OOM-killed because the cache bump raised its floor",
        impact: "nine minutes of failed reads",
        recommendation: "revert PR #482",
      });
      // The claims it was written from are untouched by the writing.
      expect(written.findings).toHaveLength(1);
      expect(written.findings[0]!.verdict).toBe("root_cause");
    });

    it("refuses a timeline whose time is not in the result it cites", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "root_cause", ["e1"]);

      const refused = await submit(sessionId, {
        summary: "the cache bump raised the floor",
        timeline: [
          {
            at: "2026-07-03T05:00:00.000Z",
            what: "first kill",
            evidenceId: "e1",
          },
        ],
        recommendation: "revert PR #482",
      });

      expect(refused.isError).toBe(true);
      // Names the entry, the id, and the times the cited result actually holds.
      expect(String(refused.content)).toContain("does not appear in e1");
      expect(String(refused.content)).toContain("2026-07-03T00:00:00.000Z");
      expect(getRecord(sessionId)!.report).toBeNull();
    });

    /* Refused rather than stored as "none": a report claiming a headline and a
       recommendation it does not have reads as complete downstream. */
    it("refuses a blank in a field the schema declares required", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "root_cause", ["e1"]);

      const refused = await submit(sessionId, {
        headline: "   ",
        summary: "the limit was lowered",
        timeline: [],
      });

      expect(refused.isError).toBe(true);
      expect(String(refused.content)).toContain("headline");
      expect(getRecord(sessionId)?.report ?? null).toBeNull();
    });

    it("stores every field once they are all filled in", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "root_cause", ["e1"]);

      await submit(sessionId, {
        summary: "the limit was lowered",
        timeline: [],
      });

      const submitted = getRecord(sessionId)!.report!;
      expect(submitted.headline).toBe("the cache bump raised the memory floor");
      expect(submitted.affected).toBe("web-01");
      expect(submitted.summary).toBe("the limit was lowered");
    });

    // One more attempt is all it gets, so "invalid input" would tell it nothing.
    it("names the field that failed rather than refusing the whole call blindly", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);

      const refused = await submit(sessionId, {
        summary: "",
        timeline: [],
        recommendation: "",
      });

      expect(refused.isError).toBe(true);
      expect(String(refused.content)).toContain("summary");
      expect(getRecord(sessionId)?.report ?? null).toBeNull();
    });
  });

  describe("evidence", () => {
    it("resolves a citation to the call that produced it, quoting the result verbatim", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "root_cause", ["e1"]);
      // The timeline cites too, so a call named only there still resolves.
      await submit(sessionId, {
        summary: "the cache bump raised the floor",
        timeline: [
          {
            at: "2026-07-03T01:00:00.000Z",
            what: "PR #482 merged",
            evidenceId: "e2",
          },
        ],
        recommendation: "revert PR #482",
      });

      const evidence = resolveEvidence(
        toolCallsIn(sessionId),
        getRecord(sessionId)!,
      );
      expect(evidence.map((e) => e.toolCallId)).toEqual(["tu-1", "tu-2"]);
      expect(evidence[0]).toMatchObject({
        toolName: "QueryMetricsRange",
        input: { query: "rss" },
      });
      // Verbatim: the result carries no tag to strip, so what the tool returned
      // is what the report quotes and what the model was shown.
      expect(JSON.parse(evidence[0]!.result)).toMatchObject({
        resultType: "matrix",
      });
      expect(JSON.parse(evidence[1]!.result)).toMatchObject({
        pullRequests: [{ number: 482 }],
      });
    });

    // The provider's own call id never appears as content, which is why one run
    // invented 21 ids rather than copy a real one.
    it("puts each call's citation handle in its own result, and takes it back", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);

      const { content } = await call("RecordFinding", sessionId, {
        verdict: "root_cause",
        explanation: "the read showed 98 percent",
        // e1 is the first call the seeded transcript holds, which is tu-1.
        candidate: "c1",
        evidenceIds: ["e1"],
      });
      expect(String(content)).toContain("Recorded f1");

      // Stored as the handle it was cited by, so the record speaks one
      // vocabulary and nothing has to translate on the way back out.
      const [hypothesis] = getRecord(sessionId)!.findings;
      expect(hypothesis?.evidenceIds).toEqual(["e1"]);

      // And it resolves to real evidence rather than a dangling reference.
      const resolved = resolveEvidence(
        toolCallsIn(sessionId),
        getRecord(sessionId)!,
      );
      expect(resolved.map((e) => e.toolCallId)).toEqual(["tu-1"]);
    });

    /* The id a result carries is the id the record resolves that call by, and a
       tool no claim may rest on carries none, so three calls leave two citable. */
    it("numbers a citable result, and leaves a recording call unnumbered", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);

      const stored = await record(
        sessionId,
        "root_cause",
        ["e1"],
        "the read showed 98 percent",
      );
      expect(getRecord(sessionId)!.findings[0]!.evidenceIds).toEqual(["e1"]);

      // Two recording calls are on the transcript by now and neither took a
      // number, so the range the refusal offers still ends at e2.
      const refused = await call("RecordFinding", sessionId, {
        verdict: "root_cause",
        explanation: "guessed",
        candidate: "c1",
        evidenceIds: ["e3"],
      });
      expect(String(refused.content)).toContain("e1 through e2");
      expect(getRecord(sessionId)!.findings).toHaveLength(1);
      expect(stored).toBe("f1");
    });

    // Counted from the transcript, the only thing that can answer it, so a
    // fifth restart at 3am is reported rather than slipped past.
    it("tells a card how often this same write already ran here", () => {
      const sessionId = randomUUID();
      seedAlertSession(
        { sessionId, title: "t", createdAt: new Date().toISOString() },
        [alert("prior-runs")],
      );
      const restart = (toolCallId: string, target: string) => ({
        toolCallId,
        name: "RestartDockerService",
        input: { target, reason: "r" },
      });
      appendCall(
        sessionId,
        0,
        restart("tu-1", "prod-1/web/api"),
        "ok",
        "T1",
        undefined,
        true,
      );
      appendCall(
        sessionId,
        2,
        restart("tu-2", "prod-1/web/api"),
        "ok",
        "T2",
        undefined,
        true,
      );
      // A different service, so it must not add to the count above.
      appendCall(
        sessionId,
        4,
        restart("tu-3", "prod-1/web/cache"),
        "ok",
        "T3",
        undefined,
        true,
      );
      appendCall(
        sessionId,
        6,
        restart("tu-4", "prod-1/web/api"),
        "ok",
        "T4",
        undefined,
        true,
      );

      const cards = buildTranscript(sessionId).flatMap((item) =>
        item.kind === "tool_call" ? [item] : [],
      );
      const priorOf = (toolCallId: string): number | undefined =>
        cards.find((c) => c.toolCallId === toolCallId)?.priorRuns;

      // Counted in transcript order, so a card reports what ran before it and
      // never counts itself.
      expect(priorOf("tu-1")).toBeUndefined();
      expect(priorOf("tu-2")).toBe(1);
      expect(priorOf("tu-3")).toBeUndefined();
      expect(priorOf("tu-4")).toBe(2);
    });

    // Refused rather than stored with what survives. One run recorded three
    // identical uncited root causes when both were said in one breath.
    it("refuses a claim whose every citation names no call", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);

      const { content } = await call("RecordFinding", sessionId, {
        verdict: "symptom",
        explanation: "",
        candidate: "c1",
        evidenceIds: ["e9", "tu-invented"],
      });
      const answer = String(content);

      expect(getRecord(sessionId)?.findings ?? []).toHaveLength(0);
      expect(answer).toContain("Not recorded");
      expect(answer).toContain("e9");
      // Told what it could have cited, in the vocabulary it was given.
      expect(answer).toMatch(/e1 through e\d+/);
    });

    /* A model that cannot see it is looping would spend the whole budget asking
       for a tool that is not there. Only the clock used to stop it. */
    it("ends a run that spends three turns asking for tools it does not have", async () => {
      const barren = {
        toolUses: [
          { toolCallId: "tu-x", name: "GetK8sLogs", input: { target: "x" } },
        ],
        text: "",
      };
      wire.script([
        {
          ...barren,
          toolUses: [{ ...barren.toolUses[0]!, toolCallId: "tu-1" }],
        },
        {
          ...barren,
          toolUses: [{ ...barren.toolUses[0]!, toolCallId: "tu-2" }],
        },
        {
          ...barren,
          toolUses: [{ ...barren.toolUses[0]!, toolCallId: "tu-3" }],
        },
        // Never reached: the run ends on the third barren turn.
        { toolUses: [], text: "still going" },
      ]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("barren"),
      ]);

      expect(await run({ sessionId, alerts: [alert("barren")] })).toBe(
        "completed",
      );

      const ended = getTranscriptRows(sessionId).find(
        (row) => row.kind === "error",
      );
      expect(ended?.content).toContain("asked only for tools");
      // It says what it did have, so the ending is actionable rather than blunt.
      expect(ended?.content).toContain("RecordFinding");
    });

    // From a real run with no runner connected: GetK8sLogs exists and was
    // withheld, the rest were invented, and all three got one sentence.
    it("tells a withheld tool from an invented one, and names a near miss", async () => {
      wire.script([
        {
          toolUses: [
            {
              toolCallId: "tu-withheld",
              name: "GetK8sLogs",
              input: { target: "x" },
            },
            { toolCallId: "tu-near", name: "RecordFindings", input: {} },
            { toolCallId: "tu-far", name: "SendSlackMessage", input: {} },
          ],
          text: "",
        },
        { toolUses: [], text: "Nothing I can reach." },
      ]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("refusals"),
      ]);

      await run({ sessionId, alerts: [alert("refusals")] });

      const answerTo = (toolCallId: string): string => {
        const part = getTranscriptRows(sessionId)
          .flatMap((row) => row.parts)
          .find((p) => p.type === "tool_result" && p.toolCallId === toolCallId);
        return part !== undefined && part.type === "tool_result"
          ? part.output
          : "";
      };

      // A real tool the fleet cannot serve blames the connection, not the name.
      const withheld = answerTo("tu-withheld");
      expect(withheld).toContain("is a real tool");
      expect(withheld).toContain("Kubernetes cluster");

      // An invented name close to a real one is pointed at it.
      const near = answerTo("tu-near");
      expect(near).toContain("There is no tool called");
      expect(near).toContain("Did you mean RecordFinding?");

      /* One that resembles nothing on offer gets no suggestion. Naming an
         unrelated tool would send the model somewhere it was never going. */
      const far = answerTo("tu-far");
      expect(far).toContain("There is no tool called");
      expect(far).not.toContain("Did you mean");

      /* All three name what the turn held: a refusal that does not is a dead
         end. The list is the phase's, so evidence gathering names the reads. */
      for (const message of [withheld, near, far]) {
        expect(message).toContain("What you do have:");
        expect(message).toContain("AskUserQuestion");
      }
    });

    // The record is built from what the turn did, so a failure reaches disk
    // without being read back out of a provider that cannot carry it.
    it("keeps a refused call's failure on the persisted result", async () => {
      wire.script([
        {
          toolUses: [
            {
              toolCallId: "tu-gone",
              name: "GetK8sLogs",
              input: { target: "x" },
            },
          ],
          text: "",
        },
        { toolUses: [], text: "done" },
      ]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("stamped"),
      ]);

      await run({ sessionId, alerts: [alert("stamped")] });

      // No Kubernetes runner is connected, so the tool is not in the offered
      // set and the turn answers with a refusal rather than a result.
      const answering = getTranscriptRows(sessionId)
        .flatMap((row) => row.parts)
        .find((p) => p.type === "tool_result" && p.toolCallId === "tu-gone");
      expect(answering).toMatchObject({ isError: true });
    });

    it("never counts an answered question as the write a later read confirms", () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      // A question suspends the run for a human exactly as a write does, and
      // changes nothing, so it starts no clock a later reading can confirm.
      appendCall(
        sessionId,
        4,
        {
          toolCallId: "tu-ask",
          name: "AskUserQuestion",
          input: { question: "Which deploy?", options: [] },
        },
        "the 14:02 one",
        "2026-07-03T02:05:00.000Z",
      );
      appendCall(
        sessionId,
        6,
        {
          toolCallId: "tu-after",
          name: "QueryMetricsRange",
          input: { query: "rss" },
        },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      // It is not a decision the user made about a write.
      expect(gatedCalls(toolCallsIn(sessionId))).toHaveLength(0);
    });

    // A refused call still carries the name of a gated tool, which is all the
    // old check looked at: five refusals read as five approved writes.
    it("never counts a call the harness refused as a write the user released", () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendCall(
        sessionId,
        4,
        {
          toolCallId: "tu-refused",
          name: "DockerExec",
          input: { target: "prod-1/app/web", executable: "df", args: ["-h"] },
        },
        'Tool "DockerExec" is not available in this investigation.',
        "2026-07-03T02:05:00.000Z",
        true,
      );
      appendCall(
        sessionId,
        6,
        {
          toolCallId: "tu-after",
          name: "QueryMetricsRange",
          input: { query: "rss" },
        },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      // Nobody was asked, so there is nothing to report either way.
      expect(gatedCalls(toolCallsIn(sessionId))).toHaveLength(0);
    });

    it("carries who released a write onto the gated call", () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendCall(
        sessionId,
        4,
        {
          toolCallId: "tu-restart",
          name: "RestartDockerService",
          input: { target: "prod-1/app/web", reason: "OOM" },
        },
        "restarted",
        "2026-07-03T02:05:00.000Z",
        undefined,
        true,
        { id: "u-7", name: "Prabhat", email: "prabhat@nw.local" },
      );

      const [call] = gatedCalls(toolCallsIn(sessionId));
      expect(call?.decision).toBe("approved");
      expect(call?.actor).toEqual({
        id: "u-7",
        name: "Prabhat",
        email: "prabhat@nw.local",
      });
    });
  });

  /* The counter is carried for the length of a run rather than recounted on
     every write, so a resume has to pick it up from the transcript. */
  it("numbers a resumed run's reads on from where the last run stopped", async () => {
    const runner = connectRunner();
    const read = (toolCallId: string) => ({
      toolUses: [
        {
          toolCallId,
          name: "ListDockerServices",
          input: { server: ["rc-host"] },
        },
      ],
      text: "",
    });
    const done = { toolUses: [], text: "Done." };
    const firstRun: ScriptedTurn[] = [read("tu-a"), done];
    const secondRun: ScriptedTurn[] = [read("tu-b"), done];
    wire.script(firstRun);

    const sessionId = randomUUID();
    seedChatSession(sessionId, "why is web slow?");
    await run({ sessionId, userMessage: "why is web slow?" });
    // A resume always carries a turn of its own, which is what a second
    // message is: a seed alone would end on the assistant and answer nothing.
    wire.script(secondRun);
    await run({
      sessionId,
      seed: buildSeed(sessionId),
      userMessage: "check again",
    });

    const issued = getTranscriptRows(sessionId)
      .flatMap((row) => row.parts)
      .flatMap((part) =>
        part.type === "tool_result" && part.evidenceId !== undefined
          ? [[part.toolCallId, part.evidenceId] as const]
          : [],
      );

    runner.disconnect();
    // A second e1 would leave two different calls answering to one citation.
    expect(issued).toEqual([
      ["tu-a", "e1"],
      ["tu-b", "e2"],
    ]);
  });

  describe("the finish gate", () => {
    let runner: HarnessRunner;
    beforeEach(() => {
      runner = connectRunner();
    });
    afterEach(() => {
      runner.disconnect();
    });

    /* Only what this run added after its opening request, so a resume's seed
       does not read as turns it wrote, and only the harness's own words. */
    function harnessMessages(index = 0): string[] {
      const start = runs[index] ?? 0;
      const last = (runs[index + 1] ?? wire.requests.length) - 1;
      const opening = messagesSentTo(wire, start).length;
      return messagesSentTo(wire, last)
        .slice(opening)
        .filter((m) => m.role === "user")
        .flatMap((m) => m.texts);
    }
    // Matched on content, not the first character: the <system-reminder> tag is
    // asserted on its own below rather than by each of these.
    function recordGapsMessages(index = 0): string[] {
      return harnessMessages(index).filter((m) =>
        m.includes("Your investigation record"),
      );
    }
    function closePrompts(index = 0): string[] {
      return harnessMessages(index).filter((m) =>
        m.includes("Your last reply called no tool"),
      );
    }
    function reportRequests(index = 0): string[] {
      return harnessMessages(index).filter((m) =>
        m.includes("Your investigation is over"),
      );
    }

    // The forced candidates turn the loop runs once the first read has answered;
    // two candidates, the tool's minimum, so a run weighs alternatives.
    function openTurn(
      candidates: unknown[] = [
        {
          statement: "the disk filled",
          ifTrue: "usage at the ceiling",
          ifFalse: "usage has headroom",
        },
        {
          statement: "the writer leaks handles",
          ifTrue: "open handles climb",
          ifFalse: "open handles are flat",
        },
      ],
    ) {
      return {
        toolUses: [
          {
            toolCallId: `tu-open-${randomUUID()}`,
            name: "OpenCandidates",
            input: { candidates },
          },
        ],
        text: "",
      };
    }

    // A fresh run reads (e1), opens, reads again (e2) and settles on e2; a reopen
    // run has its candidates already, so its one read (e3) is the post-open test.
    function recordTurn(
      verdict: string,
      open = true,
      citeId = open ? "e2" : "e3",
    ) {
      const n = randomUUID();
      const read = () => ({
        toolUses: [
          {
            toolCallId: `tu-read-${randomUUID()}`,
            name: "ListDockerServices",
            input: { server: ["rc-host"] },
          },
        ],
        text: "",
      });
      return [
        read(),
        ...(open ? [openTurn(), read()] : []),
        {
          // Both candidates settled: the report turn is reached once every one
          // the run opened carries a finding.
          toolUses: [
            {
              toolCallId: `tu-record-${n}`,
              name: "RecordFinding",
              input: {
                verdict,
                candidate: "c1",
                explanation: "what the read showed",
                evidenceIds: [citeId],
              },
            },
            {
              toolCallId: `tu-record-b-${n}`,
              name: "RecordFinding",
              input: {
                verdict: "disproven",
                candidate: "c2",
                explanation: "open handles stayed flat",
                evidenceIds: [citeId],
              },
            },
          ],
          text: "",
        },
      ];
    }

    // The run asks to finish rather than falling silent, and the harness
    // answers with the turn that comes next.
    function closeTurn() {
      return {
        toolUses: [
          {
            toolCallId: `tu-close-${randomUUID()}`,
            name: "CloseInvestigation",
            input: {},
          },
        ],
        text: "",
      };
    }

    // The one turn addressed to the reader, run with no tools after the write-up.
    const CLOSING_TURN = { toolUses: [], text: "The write-up is ready." };

    function submitTurn(recommendation = "cap concurrency at one job") {
      return {
        toolUses: [
          {
            toolCallId: "tu-submit",
            name: "ComposeReport",
            input: {
              headline: "the worker exhausted its memory limit",
              affected: "the worker",
              summary: "the worker ran out of memory",
              timeline: [],
              impact: "one job dropped",
              recommendation,
            },
          },
        ],
        text: "",
      };
    }

    // A harness turn is sent in the user's role, so it is tagged: untagged, the
    // model apologises to the person for something nobody said.
    it("marks every message it writes as its own, never as the user's", async () => {
      wire.script([
        ...recordTurn("root_cause"),
        closeTurn(),
        submitTurn(),
        CLOSING_TURN,
      ]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("tagged"),
      ]);

      await run({ sessionId, alerts: [alert("tagged")] });

      const written = harnessMessages();
      expect(written.length).toBeGreaterThan(0);
      for (const message of written) {
        expect(message.startsWith("<system-reminder>")).toBe(true);
        expect(message.endsWith("</system-reminder>")).toBe(true);
      }
    });

    /* The handle is stamped on the row and read off the same row, so a claim is
       asked to cite what the model was actually shown. */
    it("hands the model the handle its citations name", async () => {
      wire.script([
        ...recordTurn("root_cause"),
        closeTurn(),
        submitTurn(),
        CLOSING_TURN,
      ]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("handed"),
      ]);

      await run({ sessionId, alerts: [alert("handed")] });

      // The handle opens the result the model reads, which is where it cites from.
      const handles = messagesSentTo(wire, wire.requests.length - 1)
        .flatMap((m) => m.toolResults)
        .flatMap((r) => /^Evidence ID: (e\d+)/.exec(r.content)?.slice(1) ?? []);
      expect(handles).toContain("e1");
    });

    it("asks a run that calls nothing to close, then ends without a report", async () => {
      // Finishing is an act, so a run that only ever answers in prose has not
      // asked for anything: it is told so three times, then stood down.
      wire.script([{ toolUses: [], text: "All done." }]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("gate"),
      ]);
      const outcome = await run({
        sessionId,
        alerts: [alert("gate")],
      });
      expect(outcome).toBe("completed");

      const requests = closePrompts();
      expect(requests).toHaveLength(3);
      expect(requests[0]).toContain("Open your candidates now");
      // No write-up: the run never reached the record, let alone the report.
      expect(reportRequests()).toHaveLength(0);
      expect(getRecord(sessionId)?.report ?? null).toBeNull();
      // One gathering turn, three opening nudges, one stand-down, then the closing.
      expect(requestsOf(0)).toBe(6);

      // Neither the prompts nor the alert briefing NightWarden opened with is
      // drawn: the user sees one conversation, with the agent.
      const drawn = JSON.stringify(buildTranscript(sessionId));
      expect(drawn).not.toContain("Your last reply called no tool");
      expect(drawn).not.toContain("Your investigation is over");
      expect(drawn).not.toContain("<alert>");
    });

    /* A run already in falsification that has had three closes refused, then an
       answered approval: the shape an approval resume picks up. */
    function refusedThriceThenApproved(): string {
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("spent"),
      ]);
      seedCompleteReport(sessionId);
      const at = new Date().toISOString();
      const row = (
        kind: TranscriptRow["kind"],
        parts: MessagePart[],
        reminder?: ReminderKind,
      ) => ({
        sessionId,
        kind,
        content: messagePartsToText(parts),
        parts,
        timestamp: at,
        ...(reminder !== undefined && { reminder }),
      });
      const call = (toolCallId: string, name: string) =>
        row("assistant", [{ type: "tool_call", toolCallId, name, input: {} }]);
      const note = (kind: ReminderKind) =>
        row("system_reminder", [{ type: "text", text: kind }], kind);
      const rows = [
        note("alert_opening"),
        call("tu-read", "ListDockerServices"),
        row("user", [
          { type: "tool_result", toolCallId: "tu-read", output: "[]" },
        ]),
        note("falsification"),
        ...[1, 2, 3].flatMap((n) => [
          call(`tu-refused-${n}`, "CloseInvestigation"),
          row("user", [
            {
              type: "tool_result",
              toolCallId: `tu-refused-${n}`,
              output: "You have candidates you have not settled.",
              isError: true,
              refusal: { kind: "record_gaps", gaps: ["untested_candidates"] },
            },
          ]),
        ]),
        call("tu-restart", "RestartDockerService"),
        row("user", [
          {
            type: "tool_result",
            toolCallId: "tu-restart",
            output: "restarted",
          },
          { type: "tool_approval", toolCallId: "tu-restart", approved: true },
        ]),
      ];
      const first = getNextSeq(sessionId);
      appendTranscriptRows(rows.map((r, i) => ({ ...r, seq: first + i })));
      return sessionId;
    }

    // Opens a new candidate and closes in the same turn, so the close is refused.
    function openAndClose() {
      return {
        toolUses: [...openTurn().toolUses, ...closeTurn().toolUses],
        text: "",
      };
    }

    /* The allowance counts from the last time a person spoke. An approval answer
       is not a person speaking, so the resume inherits what the run spent. */
    it("carries a spent allowance across an approval resume", async () => {
      wire.script([openAndClose(), { toolUses: [], text: "Stopping here." }]);
      const sessionId = refusedThriceThenApproved();

      const outcome = await run({
        sessionId,
        seed: buildSeed(sessionId),
      });

      expect(outcome).toBe("completed");
      // The refused close, then the stand-down's closing turn: nothing in between.
      expect(requestsOf(0)).toBe(2);
      expect(closePrompts()).toHaveLength(0);
      expect(getRecord(sessionId)!.report).toBeNull();
    });

    it("resets the allowance once a person speaks", async () => {
      wire.script([openAndClose(), { toolUses: [], text: "Still thinking." }]);
      const sessionId = refusedThriceThenApproved();

      await run({
        sessionId,
        seed: buildSeed(sessionId),
        userMessage: "keep going, check the new candidate",
        clientMessageId: randomUUID(),
      });

      // The refusal spent a fresh allowance and the run carried on, so its
      // prose turns were nudged rather than stood down at once.
      expect(closePrompts()).toHaveLength(3);
    });

    /* Refused where the claim is made rather than at the finish line, because by
       the time the gate runs the turn that could fix it is over. */
    it("refuses a claim citing a call that has not answered", async () => {
      const sessionId = randomUUID();
      seedAlertSession(
        { sessionId, title: "t", createdAt: new Date().toISOString() },
        [alert("unresolvable")],
      );
      seedCandidates(sessionId);
      appendCitableRows([
        {
          sessionId,
          seq: 0,
          kind: "assistant",
          content: "[tool: QueryMetricsRange]",
          parts: [
            {
              type: "tool_call",
              toolCallId: "tu-silent",
              name: "QueryMetricsRange",
              input: { query: "rss" },
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);

      const refused = await call("RecordFinding", sessionId, {
        verdict: "root_cause",
        explanation: "rss climbed",
        candidate: "c1",
        evidenceIds: ["e1"],
      });

      /* One correction either way: the handle rides the result, so a call still
         running has none to cite and waiting is the only move. */
      expect(String(refused.content)).toContain(
        "names no result you have read",
      );
      expect(String(refused.content)).toContain("in your next message");
      expect(getRecord(sessionId)!.findings).toHaveLength(0);

      // Once the call answers, the same claim records against it.
      appendCitableRows([
        {
          sessionId,
          seq: getNextSeq(sessionId),
          kind: "user",
          content: "result",
          parts: [
            {
              type: "tool_result",
              toolCallId: "tu-silent",
              output: "rss 700MB",
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);
      await call("RecordFinding", sessionId, {
        verdict: "root_cause",
        explanation: "rss climbed",
        candidate: "c1",
        evidenceIds: ["e1"],
      });
      expect(getRecord(sessionId)!.findings).toHaveLength(1);
      expect(recordGaps(sessionId)).toEqual([]);
    });

    // The largest single output of the run, so the ceiling is where it most
    // often dies - and dying into a server log says nothing on screen.
    it("says the report was cut off rather than ending with nothing", async () => {
      wire.script([
        ...recordTurn("root_cause"),
        closeTurn(),
        { toolUses: [], text: "", stopReason: "length" },
      ]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("cut-off"),
      ]);

      const outcome = await run({
        sessionId,
        alerts: [alert("cut-off")],
      });
      expect(outcome).toBe("completed");

      const drawn = JSON.stringify(buildTranscript(sessionId));
      expect(drawn).toContain("cut off at this model's output limit");
      expect(drawn).toContain("Your findings below are complete.");
      // The record survives the failure: it is the half worth keeping.
      expect(getRecord(sessionId)!.findings).toHaveLength(2);
      expect(getRecord(sessionId)!.report).toBeNull();

      /* One report turn, not two: the same request against the same ceiling
         truncates identically, so a retry only writes a second failure. */
      expect(requestsOf(0)).toBe(6);
      expect(reportRequests()).toHaveLength(1);
    });

    // A follow-up writes over the same column, so the request carries what it
    // replaces: without it the model rewrites from a possibly compacted context.
    it("shows a reopened run the report it is replacing, as its own prior work", async () => {
      const firstRun: ScriptedTurn[] = [
        ...recordTurn("root_cause"),
        closeTurn(),
        submitTurn("free up the disk"),
        CLOSING_TURN,
      ];
      const secondRun: ScriptedTurn[] = [
        ...recordTurn("root_cause", false),
        closeTurn(),
        submitTurn("add a volume"),
        CLOSING_TURN,
      ];
      wire.script(firstRun);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("revise"),
      ]);

      await run({ sessionId, alerts: [alert("revise")] });
      // The first run has nothing to revise, so it is shown nothing.
      expect(reportRequests()[0]).not.toContain("previous-report");

      // A reopen, not a plain follow-up, is what returns the run to the record.
      wire.script(secondRun);
      await run({
        sessionId,
        seed: buildSeed(sessionId),
        userMessage: "the disk is filling again, check the volume",
        clientMessageId: randomUUID(),
        reopen: true,
      });

      const second = harnessMessages(1).find((m) =>
        m.includes("previous-report"),
      );
      expect(second).toBeDefined();
      // Its own work, named as such, with the text it is replacing.
      expect(second).toContain("You wrote this at the end of your last run");
      expect(second).toContain("free up the disk");
      expect(getRecord(sessionId)!.report).toMatchObject({
        recommendation: "add a volume",
      });
    });

    // Composing is lossy: the request says anything left out is lost, so a run
    // with nothing new must not recompose a write-up that was already right.
    it("keeps the write-up when a follow-up settles nothing new", async () => {
      const firstRun: ScriptedTurn[] = [
        ...recordTurn("root_cause"),
        closeTurn(),
        submitTurn("free up the disk"),
        CLOSING_TURN,
      ];
      const secondRun: ScriptedTurn[] = [
        { toolUses: [], text: "Nothing has changed." },
      ];
      wire.script(firstRun);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("unchanged"),
      ]);

      await run({ sessionId, alerts: [alert("unchanged")] });
      wire.script(secondRun);
      await run({
        sessionId,
        seed: buildSeed(sessionId),
        userMessage: "anything else?",
      });

      // The second run never reached its report turn, and the write-up the
      // first one composed is still the one on the record.
      expect(reportRequests(1)).toHaveLength(0);
      expect(getRecord(sessionId)!.report).toMatchObject({
        recommendation: "free up the disk",
      });
    });

    // A malformed write-up refuses whole, so the run gives up once its attempts
    // are spent, and the record it settled stands rather than a half report.
    it("gives up the write-up after its attempts are spent, leaving the record", async () => {
      wire.script([
        ...recordTurn("root_cause"),
        closeTurn(),
        ...Array.from({ length: 5 }, () => ({
          toolUses: [
            {
              toolCallId: `bad-${randomUUID()}`,
              name: "ComposeReport" as const,
              input: { headline: "" },
            },
          ],
          text: "",
        })),
      ]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("refused-writeup"),
      ]);

      const outcome = await run({
        sessionId,
        alerts: [alert("refused-writeup")],
      });
      expect(outcome).toBe("completed");
      // No write-up landed, but every finding the run settled is still on record.
      expect(getRecord(sessionId)!.report).toBeNull();
      expect(getRecord(sessionId)!.findings.length).toBeGreaterThan(0);
    });

    /* Asked over calls that answered and questioned the system: a refused call
       taught the run nothing, and recording is not reading. */
    describe("the record check", () => {
      // Two answering calls a turn, so the count crosses 8 on the fourth.
      function readTurn() {
        return {
          toolUses: [
            {
              toolCallId: randomUUID(),
              name: "ListDockerServices",
              input: { server: ["rc-host"] },
            },
            {
              toolCallId: randomUUID(),
              name: "ListDockerServices",
              input: { server: ["rc-host"] },
            },
          ],
          text: "",
        };
      }

      function checks(index = 0): string[] {
        return harnessMessages(index).filter((m) =>
          m.includes("since your last recorded finding"),
        );
      }

      it("asks when reads pile up with nothing recorded over them", async () => {
        wire.script([
          readTurn(),
          // The forced candidates turn lands here, once the first read answers.
          openTurn(),
          readTurn(),
          readTurn(),
          readTurn(),
          ...recordTurn("root_cause"),
          closeTurn(),
          submitTurn(),
          CLOSING_TURN,
        ]);
        const sessionId = randomUUID();
        seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("record-check"),
        ]);

        await run({ sessionId, alerts: [alert("record-check")] });

        expect(checks()).toHaveLength(1);
        expect(checks()[0]).toContain("answered 8 tool calls");
      });

      // Recording once buys no exemption: the debt is what has been read since
      // the last claim, so a run that settles early and reads on is asked again.
      it("asks a run that recorded early and then kept reading", async () => {
        wire.script([
          ...recordTurn("disproven"),
          readTurn(),
          readTurn(),
          readTurn(),
          readTurn(),
          closeTurn(),
          submitTurn(),
          CLOSING_TURN,
        ]);
        const sessionId = randomUUID();
        seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("record-check-quiet"),
        ]);

        await run({ sessionId, alerts: [alert("record-check-quiet")] });

        expect(checks()).toHaveLength(1);
      });
    });

    it("writes the report on a second entry, without speaking as the user", async () => {
      const firstRun: ScriptedTurn[] = [
        ...recordTurn("root_cause"),
        { toolUses: [], text: "I am done." },
        { toolUses: [], text: "Nothing changes my conclusions." },
        { toolUses: [], text: "", stopReason: "length" },
      ];
      const secondRun: ScriptedTurn[] = [
        closeTurn(),
        submitTurn("free up the disk"),
        CLOSING_TURN,
      ];
      wire.script(firstRun);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("retry"),
      ]);

      await run({ sessionId, alerts: [alert("retry")] });
      expect(getRecord(sessionId)!.report).toBeNull();

      wire.script(secondRun);
      await run({
        sessionId,
        seed: buildSeed(sessionId),
        userMessage:
          "Settle any candidate still open and write up the investigation.",
      });

      expect(getRecord(sessionId)!.report).toMatchObject({
        recommendation: "free up the disk",
      });
      const drawn = JSON.stringify(buildTranscript(sessionId));
      expect(drawn).not.toContain("Your investigation is over and its record");
    });

    // A lost write-up turn must resume into the report phase, not fall back to testing.
    it("resumes into the report phase after the write-up turn was lost", async () => {
      const firstRun: ScriptedTurn[] = [
        ...recordTurn("root_cause"),
        // Close, the challenge, close again, then a lost write-up turn.
        closeTurn(),
        { toolUses: [], text: "", stopReason: "length" },
      ];
      const secondRun: ScriptedTurn[] = [
        submitTurn("free up the disk"),
        CLOSING_TURN,
      ];
      wire.script(firstRun);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("resume-report"),
      ]);

      await run({ sessionId, alerts: [alert("resume-report")] });
      expect(getRecord(sessionId)!.report).toBeNull();

      wire.script(secondRun);
      await run({
        sessionId,
        seed: buildSeed(sessionId),
        userMessage: "Write up the investigation.",
      });

      // The resumed run reached ComposeReport rather than being refused it.
      expect(getRecord(sessionId)!.report).toMatchObject({
        recommendation: "free up the disk",
      });
      // The challenge was answered in the first run, so it is not put again.
      expect(
        harnessMessages(1).filter((m) =>
          m.includes("test your own conclusions"),
        ),
      ).toHaveLength(0);
    });

    it("passes silently once the record holds a settled claim, then writes up", async () => {
      wire.script([
        ...recordTurn("disproven"),
        closeTurn(),
        submitTurn("watch the disk for another day"),
        CLOSING_TURN,
      ]);
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("gate-pass"),
      ]);
      const outcome = await run({
        sessionId,
        alerts: [alert("gate-pass")],
      });
      expect(outcome).toBe("completed");

      expect(recordGapsMessages()).toHaveLength(0);
      expect(reportRequests()).toHaveLength(1);
      // The record rides the request, so the timeline can copy ids from nearby.
      expect(reportRequests()[0]).toContain("RECORDED FINDINGS");
      // The verdict and the handles, so a timeline can copy an id from nearby.
      expect(reportRequests()[0]).toContain("[disproven] cites: e2");

      const written = getRecord(sessionId)!;
      expect(written.findings[0]!.verdict).toBe("disproven");
      expect(written.report).toMatchObject({
        summary: "the worker ran out of memory",
        recommendation: "watch the disk for another day",
      });
    });

    it("does not write up a chat, which keeps no record at all", async () => {
      wire.script([{ toolUses: [], text: "Nine containers." }]);
      const sessionId = randomUUID();
      seedChatSession(sessionId, "how many containers are running?");
      const outcome = await run({
        sessionId,
        userMessage: "how many containers are running?",
      });
      expect(outcome).toBe("completed");
      expect(harnessMessages()).toHaveLength(0);
      expect(getRecord(sessionId)).toBeUndefined();
    });

    // Ruling things out is a complete ending; releasing a write and then going
    // quiet with the condition still firing is not.
    describe("a run that acted", () => {
      // A write the user was asked about and let through, recorded on the call
      // where it happened. Nothing about the tool's name could say this.
      function releasedWrite(sessionId: string, seq: number): void {
        appendCall(
          sessionId,
          seq,
          {
            toolCallId: "tu-released",
            name: "RestartDockerService",
            input: { target: "prod-1/app/web" },
          },
          "restarted",
          "2026-07-03T02:05:00.000Z",
          undefined,
          true,
        );
      }

      function settledRun(...extra: ReturnType<typeof submitTurn>[]) {
        wire.script([
          ...recordTurn("disproven"),
          closeTurn(),
          ...extra,
          CLOSING_TURN,
        ]);
      }

      it("is asked for a recommendation when nothing can confirm recovery", async () => {
        settledRun();
        const sessionId = randomUUID();
        seedAlertSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-firing")],
        );
        releasedWrite(sessionId, 0);

        await run({ sessionId, alerts: [alert("acted-firing")] });

        const request = reportRequests()[0]!;
        // Never "try again": repeating a write that did not work is the failure
        // this gate exists to catch.
        expect(request).not.toContain("try again");
        expect(request).toContain("Nothing can confirm");
      });

      // The refusal names the field, while the request that follows says only
      // that the report is unwritten, which is true either way.
      it("refuses a write-up that recommends nothing, and asks again", async () => {
        settledRun(submitTurn(""), submitTurn("cap concurrency at one job"));
        const sessionId = randomUUID();
        seedAlertSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-no-recommendation")],
        );
        releasedWrite(sessionId, 0);

        await run({
          sessionId,
          alerts: [alert("acted-no-recommendation")],
        });

        const retries = harnessMessages().filter((m) =>
          m.includes("did not land"),
        );
        expect(retries).toHaveLength(1);
        expect(getRecord(sessionId)!.report!.recommendation).toBe(
          "cap concurrency at one job",
        );
      });

      it("says nothing about recovery to a run that only looked", async () => {
        settledRun();
        const sessionId = randomUUID();
        seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("only-looked"),
        ]);
        await run({ sessionId, alerts: [alert("only-looked")] });

        // No write was released, so an ending that names no cause stands even
        // though the alert never cleared.
        expect(recordGapsMessages()).toHaveLength(0);
        const request = reportRequests()[0]!;
        expect(request).not.toContain("is still firing");
        expect(request).not.toContain("Nothing can confirm");
      });
    });
  });
});
