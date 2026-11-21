import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeModel, createGateController } from "./fake-model.js";
import { harness, type Harness } from "./harness.js";
import { messageBody } from "./session-helper.js";

const scripted = fakeModel();

import { waitFor } from "./wait.js";

import { isRunning } from "../session/status-store.js";
import { getSession } from "../session/store.js";
import { seedCompleteReport } from "./report-helper.js";

describe("DELETE /sessions/:id", () => {
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

  it("deletes a finished session and returns 204", async () => {
    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody("Quick question."),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };
    await waitFor(() => !isRunning(sessionId));

    const delRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { Cookie: `${SESSION}` },
      },
    );
    expect(delRes.status).toBe(204);
    expect(getSession(sessionId)).toBeUndefined();
  });

  it("leaves no report behind: the report route 404s once the session is gone", async () => {
    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody("What happened here?"),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };
    await waitFor(() => !isRunning(sessionId));
    seedCompleteReport(sessionId);

    const before = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/report`,
      { headers: { Cookie: `${SESSION}` } },
    );
    expect(before.status).toBe(200);

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Cookie: `${SESSION}` },
    });

    const after = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/report`,
      { headers: { Cookie: `${SESSION}` } },
    );
    expect(after.status).toBe(404);
  });

  it("returns 409 and does not delete a session that is currently running", async () => {
    const gateController = createGateController();
    scripted.park(gateController.gate);

    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: messageBody("Long running."),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };
    await waitFor(() => isRunning(sessionId));

    const delRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { Cookie: `${SESSION}` },
      },
    );
    expect(delRes.status).toBe(409);
    expect(getSession(sessionId)).toBeDefined();

    scripted.park();
    gateController.releaseAll();
    await waitFor(() => !isRunning(sessionId));
  });
});
