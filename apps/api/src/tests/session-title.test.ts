import { fakeModel } from "./fake-model.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  FrontendEvent,
  NormalizedAlert,
  ResolvedLLMConfig,
} from "@nightwarden/shared";
import { subscribeFrontend } from "../session/bus.js";
import { createSession, getSession } from "../session/store.js";
import {
  buildAlertTitleSource,
  generateSessionTitle,
} from "../session/title.js";
import { harness, type Harness } from "./harness.js";
import { messageBody } from "./session-helper.js";
import { waitFor } from "./wait.js";

const scripted = fakeModel();

// Title generation only runs inside a configured session, so the test states
// that precondition rather than depending on what an empty config returns.
function configuredConfig(): ResolvedLLMConfig {
  return {
    provider: "anthropic",
    model: "test-model",
    maxOutputTokens: 4096,
    maxInputTokens: null,
    compaction: false,
    maxRetries: 0,
    reasoningLevel: null,
    reasoning: {
      levels: [
        { value: "high", label: "High" },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      defaultLevel: "high",
    },
  };
}

async function title(sessionId: string, source: string): Promise<void> {
  const config = configuredConfig();
  await generateSessionTitle(sessionId, source, scripted.model, config);
}

// The title arrives in a field: the model files it rather than saying it.
function scriptTitleOnce(filed: string): void {
  scripted.titles({
    toolUses: [
      { toolCallId: "tu-title", name: "SetTitle", input: { title: filed } },
    ],
    text: "",
  });
}

// A model that answers in prose instead, which the text path still reads.
function scriptTitleAsProse(text: string): void {
  scripted.titles({ toolUses: [], text });
}

async function seedSession(
  sessionId: string,
  temporary: string,
): Promise<void> {
  await createSession({
    sessionId,
    title: temporary,
    createdAt: new Date().toISOString(),
  });
}

describe("session title generation", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness({ model: scripted });
    ({ port } = nw);
    SESSION = nw.session;
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  it("sends the message as quoted material on a small budget, not as a live turn", async () => {
    scriptTitleAsProse("Greeting");
    const sessionId = "sess-title-framing";
    await seedSession(sessionId, "temp");

    await title(sessionId, "Hey there, how's it going?");

    const request = scripted.titleRequests.at(-1);
    const framed = JSON.stringify(
      request?.prompt.find((m) => m.role === "user")?.content,
    );
    expect(framed).toContain("Hey there, how's it going?");
    expect(framed).toContain("<content>");
    expect(request?.maxOutputTokens).toBe(1024);
    expect((await getSession(sessionId))?.title).toBe("Greeting");
  });

  it("strips trailing punctuation, including after the word cap", async () => {
    scriptTitleOnce("Identity Inquiry,");
    const sessionId = "sess-title-comma";
    await seedSession(sessionId, "temp");
    await title(sessionId, "who are you?");
    expect((await getSession(sessionId))?.title).toBe("Identity Inquiry");

    scriptTitleOnce("One Two Three Four, Five");
    const sessionId2 = "sess-title-comma-2";
    await seedSession(sessionId2, "temp");
    await title(sessionId2, "some question");
    expect((await getSession(sessionId2))?.title).toBe("One Two Three Four");
  });

  /* "Here's a thinking process" was the first four words of a reply that had
     not started: the field cannot carry a preamble, but the fallback still can. */
  it("reads a title out of prose when the model will not call the tool", async () => {
    scriptTitleAsProse("Redis OOM Restart");
    const sessionId = "sess-title-prose";
    await seedSession(sessionId, "temp");

    await title(sessionId, "redis is full");

    expect((await getSession(sessionId))?.title).toBe("Redis OOM Restart");
  });

  it("leaves the title untouched when the model returns nothing usable", async () => {
    scriptTitleOnce("   ");
    const sessionId = "sess-title-3";
    await seedSession(sessionId, "original temp title");

    await title(sessionId, "some question");

    expect((await getSession(sessionId))?.title).toBe("original temp title");
  });

  it("builds an alert title source capped to the first ten alerts", () => {
    const alerts = Array.from({ length: 14 }, (_, i): NormalizedAlert => ({
      sourceAlertId: `a-${i}`,
      labels: {
        alertname: "cpu_high",
        severity: "critical",
        container: `svc-${i}`,
      },
      alertType: "cpu_high",
      firedAt: "2024-01-01T00:00:00Z",
      annotations: {},
      generatorURL: null,
      values: {},
    }));

    const lines = buildAlertTitleSource(alerts).split("\n");

    expect(lines).toHaveLength(10);
    // The labels themselves, not a resolved key: the title model gets more to
    // work with from what the alert said than from a key assembled after the fact.
    expect(lines[0]).toBe("[cpu_high] container=svc-0 (critical)");
  });

  it("refines the title end-to-end when a chat session starts", async () => {
    scripted.script([{ toolUses: [], text: "Done." }]);
    scriptTitleOnce('"Checkout Latency Spike".');
    const events: FrontendEvent[] = [];
    const unsubscribe = subscribeFrontend((e) => events.push(e));

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody("Why is checkout slow?"),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Fire-and-forget: wait on the row, not on the run finishing.
    await waitFor(
      async () =>
        (await getSession(sessionId))?.title === "Checkout Latency Spike",
    );
    unsubscribe();
    const titleEvent = events.find((e) => e.type === "SESSION_TITLE_UPDATED");
    expect(titleEvent?.payload).toMatchObject({
      sessionId,
      title: "Checkout Latency Spike",
    });
  });
});
