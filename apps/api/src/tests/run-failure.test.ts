import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FrontendEvent } from "@nightwarden/shared";
import { turnEnding } from "../agent/loop/endings.js";
import { getTranscriptRows } from "../session/transcript-store.js";
import { fakeModel, messagesSentTo } from "./fake-model.js";
import {
  connectFrontendEvents,
  type FrontendEventsClient,
} from "./frontend-events-helper.js";
import { harness, type Harness } from "./harness.js";
import { messageBody } from "./session-helper.js";
import { expectInvestigationFailure } from "./setup.js";
import { waitFor } from "./wait.js";

const scripted = fakeModel();

describe("run failure surfacing (dispatch -> transcript -> SSE)", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;
  let client: FrontendEventsClient<FrontendEvent>;

  beforeAll(async () => {
    nw = await harness({ model: scripted });
    ({ port } = nw);
    SESSION = nw.session;
    client = await connectFrontendEvents<FrontendEvent>(port, SESSION);
  });

  afterAll(async () => {
    client.close();
    await nw.close();
    vi.unstubAllEnvs();
  });

  async function startChat(message: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody(message),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    return sessionId;
  }

  function retryEventsFor(sessionId: string) {
    return client.events.filter(
      (e) => e.type === "RUN_RETRYING" && e.payload.sessionId === sessionId,
    );
  }

  it("persists a plain-language error row when the provider gives up, and publishes it", async () => {
    // Retried at once, as the retry-after says, until the attempts are spent.
    scripted.script([{ status: 529, retryAfterSeconds: 0 }]);

    const sessionId = await startChat("what is down?");

    const failed = await waitFor(() =>
      client.events.find(
        (e) => e.type === "RUN_FAILED" && e.payload.sessionId === sessionId,
      ),
    );
    if (failed.type !== "RUN_FAILED") throw new Error("unreachable");
    expect(failed.payload.message.kind).toBe("error");

    const messages = await getTranscriptRows(sessionId);
    expect(messages.map((m) => [m.seq, m.kind])).toEqual([
      [0, "user"],
      [1, "error"],
    ]);
    expectInvestigationFailure();
  });

  it("fails immediately on a 401 - no retries, key guidance in the transcript", async () => {
    scripted.script([{ status: 401 }]);

    const sessionId = await startChat("hello");

    const failed = await waitFor(() =>
      client.events.find(
        (e) => e.type === "RUN_FAILED" && e.payload.sessionId === sessionId,
      ),
    );
    if (failed.type !== "RUN_FAILED") throw new Error("unreachable");
    expect(failed.payload.message.content).toContain("rejected the API key");
    expect(retryEventsFor(sessionId)).toHaveLength(0);
    expectInvestigationFailure();
  });

  it("resume after a failure: dead exchange is not replayed, seq continues past it", async () => {
    scripted.script([{ status: 401 }]);

    const sessionId = await startChat("first question");
    await waitFor(() =>
      client.events.find(
        (e) => e.type === "RUN_FAILED" && e.payload.sessionId === sessionId,
      ),
    );

    const retried = scripted.requests.length;
    scripted.script([{ toolUses: [], text: "Fresh answer." }]);
    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: messageBody("try again"),
      },
    );
    expect(res.status).toBe(202);

    await waitFor(async () =>
      (await getTranscriptRows(sessionId)).some((m) => m.kind === "assistant"),
    );

    // The failed exchange stays in the transcript but never reached the model,
    // so the retry carries the new message alone.
    expect(
      messagesSentTo(scripted, retried).map((m) => [m.role, m.texts]),
    ).toEqual([["user", ["try again"]]]);
    expect(
      (await getTranscriptRows(sessionId)).map((m) => [m.seq, m.kind]),
    ).toEqual([
      [0, "user"],
      [1, "error"],
      [2, "user"],
      [3, "assistant"],
    ]);
    expectInvestigationFailure();
  });

  // The provider retries a failed stream itself; the run's part is telling the reader.
  it("tells the reader when a reply is starting over", async () => {
    scripted.script([
      { text: "Half a rep", overloadedAfter: true },
      { toolUses: [], text: "Recovered fine." },
    ]);

    const sessionId = await startChat("summarize the codebase");

    await waitFor(() =>
      client.events.find(
        (e) => e.type === "RUN_FINISHED" && e.payload.sessionId === sessionId,
      ),
    );
    const retry = retryEventsFor(sessionId)[0];
    expect(retry?.type === "RUN_RETRYING" && retry.payload.summary).toContain(
      "attempt 2 of 4",
    );
    const roles = (await getTranscriptRows(sessionId)).map((m) => m.kind);
    expect(roles).toEqual(["user", "assistant"]);
  });

  // A turn with no tool calls otherwise reads as a finished reply, so the reason is named first.
  it.each(["length", "filtered", "paused"] as const)(
    "says a turn ended for %s instead of reading what it held as an answer",
    async (reason) => {
      scripted.script([
        {
          toolUses: [],
          text: "Partial answer that stops mid-",
          stopReason: reason,
        },
      ]);

      const sessionId = await startChat("explain everything");

      await waitFor(() =>
        client.events.find(
          (e) => e.type === "RUN_FINISHED" && e.payload.sessionId === sessionId,
        ),
      );

      const ending = (await getTranscriptRows(sessionId)).find(
        (m) => m.kind === "error",
      );
      expect(ending?.content).toBe(turnEnding(reason, 32_000));
    },
  );
});
