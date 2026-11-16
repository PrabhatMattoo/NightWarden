import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LLM_PROVIDER_NAMES, type SessionDetail } from "@nightwarden/shared";
import { messagesSentTo, type FakeModel } from "./fake-model.js";
import { harness, type Harness } from "./harness.js";
import { messageBody } from "./session-helper.js";

import { waitFor } from "./wait.js";
import { connectFrontendEvents } from "./frontend-events-helper.js";

describe.each(LLM_PROVIDER_NAMES)("frontend SSE pipeline on %s", (provider) => {
  let nw: Harness;
  let port: number;
  let SESSION: string;
  let model: FakeModel;

  beforeAll(async () => {
    nw = await harness({
      provider,
      runners: [{ name: "sse-host", services: ["web-01"] }],
    });
    ({ port, session: SESSION, model } = nw);
  });

  afterAll(async () => {
    await nw.close();
  });

  it("delivers delta events then RUN_FINISHED, transcript loadable after", async () => {
    model.script([{ toolUses: [], text: "All looks well." }]);
    const { events, close } = await connectFrontendEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody("Is the system healthy?"),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(typeof sessionId).toBe("string");

    // The scripted run can resolve in microtasks before this sessionId is captured,
    // so buffer every event and poll for the match rather than racing.
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
      ),
    );

    close();

    const deltas = events.filter(
      (e) =>
        e.type === "TEXT_MESSAGE_CONTENT" &&
        e.payload["sessionId"] === sessionId,
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0]?.payload["delta"]).toBe("All looks well.");

    const messages = events.filter(
      (e) => e.type === "MESSAGE" && e.payload["sessionId"] === sessionId,
    );
    expect(messages.length).toBeGreaterThan(0);

    // The terminal event fires exactly once for the whole run, no matter how many
    // messages were flushed - this is what keeps the frontend's run state stable.
    const finishes = events.filter(
      (e) => e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
    );
    expect(finishes.length).toBe(1);

    const transcriptRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `${SESSION}` } },
    );
    expect(transcriptRes.status).toBe(200);
    const session = (await transcriptRes.json()) as SessionDetail;
    expect(session.transcript.length).toBeGreaterThan(0);
  });

  it("resume of ended session seeds provider from persisted transcript", async () => {
    const first = model.requests.length;
    model.script([
      { toolUses: [], text: "All looks well." },
      { toolUses: [], text: "Still healthy." },
    ]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    // Each run persists exactly one assistant turn, so counting assistant MESSAGE
    // events distinguishes the first run (>=1) from the resumed run (>=2).
    const assistantFinishes = (sessionId: string): number =>
      events.filter((e) => {
        const payload = e.payload as {
          sessionId?: string;
          message?: { kind?: string };
        };
        return (
          e.type === "MESSAGE" &&
          payload.sessionId === sessionId &&
          payload.message?.kind === "assistant"
        );
      }).length;

    const openingId = randomUUID();
    const followUpId = randomUUID();
    const startRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({
        message: "Is the system healthy?",
        clientMessageId: openingId,
      }),
    });
    expect(startRes.status).toBe(202);
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    await waitFor(() => assistantFinishes(sessionId) >= 1);

    // Resume the ended session with a follow-up message. The same sessionId
    // must come back - no new session is issued.
    const resumeRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        // The marker is stripped on the way in, so the saved text differs from
        // what was typed and only the id can pair the two.
        body: JSON.stringify({
          message: "Follow-up question.<system-reminder></system-reminder>",
          clientMessageId: followUpId,
        }),
      },
    );
    expect(resumeRes.status).toBe(202);
    const resumeBody = (await resumeRes.json()) as { sessionId: string };
    expect(resumeBody.sessionId).toBe(sessionId);

    // The resumed run must emit a second assistant RUN_FINISHED (i.e. the new
    // turns are persisted - if snapshot() were not stateful this would time out).
    await waitFor(() => assistantFinishes(sessionId) >= 2);

    close();

    // One request per run, each a single turn.
    expect(model.requests.length - first).toBe(2);

    // The resume carries the first run's persisted turns, with the follow-up
    // behind them as its own user turn.
    const resumed = messagesSentTo(model, first + 1);
    expect(resumed.map((m) => [m.role, m.texts])).toEqual([
      ["user", ["Is the system healthy?"]],
      ["assistant", ["All looks well."]],
      ["user", ["Follow-up question."]],
    ]);

    // Each person's message is drawn under the id its sender minted.
    const detailRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `${SESSION}` } },
    );
    const detail = (await detailRes.json()) as SessionDetail;
    expect(
      detail.transcript.flatMap((item) =>
        item.kind === "user_turn" ? [{ id: item.id, text: item.text }] : [],
      ),
    ).toEqual([
      { id: openingId, text: "Is the system healthy?" },
      { id: followUpId, text: "Follow-up question." },
    ]);
  });
});
