import { harness, type Harness } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";
import { createContractFakeProvider } from "./contract-fake-provider.js";

mockCreateProvider.mockImplementation(() =>
  createContractFakeProvider([{ toolUses: [], text: "Done." }]),
);

import { randomUUID } from "node:crypto";

import { registerSessionRoutes } from "../session/routes.js";
import { buildSessionMeta } from "../agent/loop/run-session.js";
import { seedAlertSession, seedChatSession } from "./session-helper.js";

// The route decides who may reopen: only a closed investigation, so its three
// refusals are what this pins. The reopened run itself is exercised in report.test.
describe("POST /sessions/:id/reopen", () => {
  let nw: Harness;

  beforeAll(async () => {
    nw = await harness({ routes: [registerSessionRoutes] });
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  async function reopen(id: string): Promise<Response> {
    return await fetch(nw.url(`/api/sessions/${id}/reopen`), {
      method: "POST",
      headers: { Cookie: nw.session },
    });
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
});
