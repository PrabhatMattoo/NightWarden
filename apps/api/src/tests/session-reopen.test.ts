import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeAnthropic } from "./fake-anthropic.js";
import { harness, type Harness } from "./harness.js";

const anthropic = fakeAnthropic();

import { buildSessionMeta } from "../agent/loop/run-session.js";
import { isRunning } from "../session/status-store.js";
import { isReopenable } from "../session/reopen.js";
import { getTranscriptRows } from "../session/transcript-store.js";
import {
  dispatchAlertSession,
  seedAlertSession,
  seedChatSession,
} from "./session-helper.js";
import { waitFor } from "./wait.js";

// The route decides who may reopen and what the reopened run is handed first.
// What that run does with the record is exercised in report.test.
describe("POST /sessions/:id/reopen", () => {
  let nw: Harness;

  beforeAll(async () => {
    nw = await harness({ model: anthropic });
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  async function reopen(
    id: string,
    body: Record<string, unknown> = {
      reason: "the disk filled again after the fix",
      clientMessageId: randomUUID(),
    },
  ): Promise<Response> {
    return await fetch(nw.url(`/api/sessions/${id}/reopen`), {
      method: "POST",
      headers: { Cookie: nw.session, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // Settled as untestable, so the run closes and writes up without a runner.
  const settle = (candidate: string) => ({
    toolCallId: `tu-settle-${candidate}`,
    name: "RecordFinding",
    input: {
      verdict: "untestable",
      candidate,
      explanation: "no tool reaches the disk",
      evidenceIds: [],
    },
  });

  async function closedInvestigation(): Promise<string> {
    anthropic.script([
      { toolUses: [], text: "Looking." },
      {
        toolUses: [
          {
            toolCallId: "tu-open",
            name: "OpenCandidates",
            input: {
              candidates: [
                {
                  statement: "the disk filled",
                  ifTrue: "full",
                  ifFalse: "headroom",
                },
                {
                  statement: "a writer leaks",
                  ifTrue: "climbs",
                  ifFalse: "flat",
                },
              ],
            },
          },
        ],
        text: "",
      },
      { toolUses: [settle("c1"), settle("c2")], text: "" },
      {
        toolUses: [
          { toolCallId: "tu-close", name: "CloseInvestigation", input: {} },
        ],
        text: "",
      },
      {
        toolUses: [
          {
            toolCallId: "tu-compose",
            name: "ComposeReport",
            input: {
              headline: "the disk could not be checked",
              affected: "the worker",
              summary: "no tool could reach the disk",
              timeline: [],
              impact: "unknown",
              recommendation: "add a disk usage metric",
            },
          },
        ],
        text: "",
      },
      { toolUses: [], text: "The report is ready." },
    ]);
    const id = randomUUID();
    await dispatchAlertSession(nw.dispatcher, id, [
      {
        sourceAlertId: `reopen-${id}`,
        labels: {},
        alertType: "DiskFull",
        firedAt: new Date().toISOString(),
        annotations: {},
        generatorURL: null,
        values: {},
      },
    ]);
    await waitFor(() => isReopenable(id));
    // What the reopened run is answered with: one free-form turn.
    anthropic.script([]);
    return id;
  }

  it("404s an id no session answers to", async () => {
    expect((await reopen(randomUUID())).status).toBe(404);
  });

  it("refuses a chat, which has no investigation to reopen", async () => {
    const id = randomUUID();
    await seedChatSession(id, "hello");
    expect((await reopen(id)).status).toBe(400);
  });

  it("refuses an investigation that has not closed", async () => {
    const id = randomUUID();
    await seedAlertSession(buildSessionMeta(id, null, undefined), []);
    expect((await reopen(id)).status).toBe(409);
  });

  it("refuses a reopen that gives no reason", async () => {
    const id = randomUUID();
    await seedAlertSession(buildSessionMeta(id, null, undefined), []);
    const response = await reopen(id, {
      reason: "   ",
      clientMessageId: randomUUID(),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "reason is required",
    );
  });

  // The reason is the person's turn; the harness row after it explains the reopen.
  it("writes the reason in the person's voice, then the reopen turn", async () => {
    const id = await closedInvestigation();
    const clientMessageId = randomUUID();
    const response = await reopen(id, {
      reason: "  the disk filled again after the fix  ",
      clientMessageId,
    });
    expect(response.status).toBe(202);

    const rows = await waitFor(async () =>
      (await isRunning(id)) ? null : await getTranscriptRows(id),
    );
    const reason = rows.findIndex((row) => row.clientId === clientMessageId);
    expect(rows[reason]).toMatchObject({
      kind: "user",
      content: "the disk filled again after the fix",
    });
    expect(rows[reason + 1]).toMatchObject({
      kind: "system_reminder",
      reminder: "reopen",
    });
  });
});
