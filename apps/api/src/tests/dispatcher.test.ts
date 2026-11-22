import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { createDispatcher } from "../dispatcher.js";
import { isRunning } from "../session/status-store.js";
import type { RunSessionInput, RunOutcome } from "../agent/loop/run-session.js";
import type { NormalizedAlert } from "@nightwarden/shared";
import { seedAlertSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";

// The gate resolves with a run outcome; these tests exercise claiming and
// stopping, so a plain "completed" stands in for every run.
function deferred(): { promise: Promise<RunOutcome>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<RunOutcome>((r) => {
    resolve = () => r("completed");
  });
  return { promise, resolve };
}

// Drain all pending microtasks through the async promise chain (.catch, .finally).
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const FIRED_AT = "2026-07-07T03:00:00.000Z";

function makeAlert(sourceAlertId: string, firedAt = FIRED_AT): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    alertName: "HighCPU",
    firedAt,
    annotations: {},
    generatorURL: null,
    values: {},
  };
}

// Every session row exists before anything dispatches into it: the chat route
// writes it, and ingest writes it together with the alerts it opens on.
function seedSession(sessionId: string, alerts: NormalizedAlert[]): void {
  seedAlertSession(
    { sessionId, title: "t", createdAt: new Date().toISOString() },
    alerts,
  );
}

describe("dispatcher", () => {
  // Claiming a run is a write to the session row, so this seam needs a
  // database even with the run itself faked.
  let cleanupDb: () => void;
  beforeAll(() => {
    cleanupDb = useTempDb();
  });
  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("refuses to dispatch into a session nothing has written", () => {
    const dispatcher = createDispatcher({
      run: () => Promise.resolve<RunOutcome>("completed"),
    });
    expect(dispatcher.dispatch({ sessionId: "never-created" })).toBe(false);
  });

  // The conditional UPDATE is the mutex, not a check before it, so the loser
  // is told rather than colliding on the transcript's primary key.
  it("refuses a second dispatch for a session a run already holds", async () => {
    const gate = deferred();
    const dispatcher = createDispatcher({ run: () => gate.promise });
    const sessionId = "s-race";
    seedSession(sessionId, [makeAlert("race-1")]);

    expect(dispatcher.dispatch({ sessionId })).toBe(true);
    expect(dispatcher.dispatch({ sessionId })).toBe(false);
    expect(isRunning(sessionId)).toBe(true);

    gate.resolve();
    await flush();
    expect(isRunning(sessionId)).toBe(false);
    // Released, so the same session can run again - which is what a resume is.
    expect(dispatcher.dispatch({ sessionId })).toBe(true);
  });

  it("stop aborts the running session's signal, and answers false for an idle one", async () => {
    let seen: AbortSignal | undefined;
    const gate = deferred();
    const dispatcher = createDispatcher({
      run: (input: RunSessionInput) => {
        seen = input.signal;
        return gate.promise;
      },
    });
    const sessionId = "s-stop";
    seedSession(sessionId, [makeAlert("stop-1")]);

    expect(dispatcher.stop(sessionId)).toBe(false);
    dispatcher.dispatch({ sessionId });
    expect(dispatcher.stop(sessionId)).toBe(true);
    expect(seen?.aborted).toBe(true);

    gate.resolve();
    await flush();
    expect(dispatcher.stop(sessionId)).toBe(false);
  });
});
