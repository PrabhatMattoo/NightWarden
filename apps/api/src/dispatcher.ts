import { runSession } from "./agent/loop/run-session.js";
import type { RunSessionInput, RunOutcome } from "./agent/loop/run-session.js";
import {
  claimRun,
  clearRunFailure,
  isRunning,
  recordRunFailure,
  releaseRun,
} from "./session/status-store.js";
import { sessionExists } from "./session/store.js";
import { appendErrorMessage } from "./session/transcript-store.js";
import { markStopped } from "./session/status-store.js";
import { describeLLMError, isRetryableLLMError } from "./llm/failures.js";
import { loadConfig } from "./config/store.js";
import { logger } from "./logger.js";
import {
  publishRunFailed,
  publishRunFinished,
  publishRunStopped,
} from "./session/stream.js";
import type { TranscriptRow } from "@nightwarden/shared";

// Alert, chat, Start and resume all funnel through here; what an alert joins is
// the sender's group key, decided where the alert is stored.
interface Dispatcher {
  // Answers whether the run started. False means the session already holds a
  // run, which is a race the caller reports rather than a fault.
  dispatch(input: RunSessionInput): Promise<boolean>;
  // Runs a session its opening transaction already claimed as running.
  launch(input: RunSessionInput): void;
  // guards the 409 on POST /sessions/:id/messages
  isSessionRunning(sessionId: string): Promise<boolean>;
  // Aborts the in-flight LLM request for a running session. Returns false if
  // the session isn't currently running.
  stop(sessionId: string): boolean;
}

interface DispatcherOptions {
  run: (input: RunSessionInput) => Promise<RunOutcome>;
}

// How a run ended, named once. Consumers subscribe to this rather than working
// out which promise arm they are in - .finally fires on a suspend as well.
type RunEnding = RunOutcome | "failed";

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const { run } = opts;

  const controllers = new Map<string, AbortController>();

  /* Classified here or not at all: only the error object can say whether trying
     again could ever work, and it does not survive into the transcript row. */
  async function recordFailure(sessionId: string, err: unknown): Promise<void> {
    logger.error({ err, sessionId }, "investigation failed");
    await recordRunFailure(
      sessionId,
      isRetryableLLMError(err) ? "transient" : "permanent",
    );
    // The failure becomes a durable transcript row rendered like any other
    // message; a synthetic row still unsticks the frontend if persist fails.
    const text = describeLLMError(err, (await loadConfig()).maxRetries);
    let row: TranscriptRow;
    try {
      row = await appendErrorMessage(sessionId, text);
    } catch (persistErr: unknown) {
      logger.warn(
        { err: persistErr, sessionId },
        "run failure row not persisted",
      );
      row = {
        sessionId,
        seq: 0,
        kind: "error",
        content: text,
        parts: [],
        timestamp: new Date().toISOString(),
      };
    }
    publishRunFailed(sessionId, row);
  }

  // Every run ends here, named. Exactly one terminal event each: a suspended run
  // already published its interrupt, and a failed one its row above.
  async function onRunEnded(
    sessionId: string,
    ending: RunEnding,
  ): Promise<void> {
    if (ending === "failed") return;
    // A run that reached an ending, however it ended, is not a failure any more,
    // so it stops carrying one and gets its full three attempts back.
    await clearRunFailure(sessionId);
    if (ending === "completed") publishRunFinished(sessionId);
    else if (ending === "stopped") {
      await markStopped(sessionId);
      publishRunStopped(sessionId);
    }
  }

  async function start(input: RunSessionInput): Promise<boolean> {
    // Claimed durably first, so a restart can tell a run that was alive from one
    // that concluded, and a second dispatch cannot start.
    if (!(await sessionExists(input.sessionId))) {
      logger.error(
        { sessionId: input.sessionId },
        "dispatch refused: no such session, its row must be written first",
      );
      return false;
    }
    if (!(await claimRun(input.sessionId))) {
      logger.warn(
        { sessionId: input.sessionId },
        "dispatch refused: a run already holds this session",
      );
      return false;
    }
    launch(input);
    return true;
  }

  function launch(input: RunSessionInput): void {
    const controller = new AbortController();
    controllers.set(input.sessionId, controller);
    void supervise(input, controller);
  }

  // One run from its start to its release, so a failure anywhere is recorded as the run's.
  async function supervise(
    input: RunSessionInput,
    controller: AbortController,
  ): Promise<void> {
    try {
      const outcome = await run({ ...input, signal: controller.signal });
      await onRunEnded(input.sessionId, outcome);
    } catch (err: unknown) {
      await recordFailure(input.sessionId, err);
      await onRunEnded(input.sessionId, "failed");
    } finally {
      // Conditional on 'running', so a run that suspended stays waiting on its human.
      await releaseRun(input.sessionId);
      controllers.delete(input.sessionId);
    }
  }

  return {
    dispatch: start,
    launch,

    // Read from the row, not from memory: a run that died with the process is
    // not running, and only the row survives to say so.
    async isSessionRunning(sessionId: string): Promise<boolean> {
      return await isRunning(sessionId);
    },

    stop(sessionId: string): boolean {
      const controller = controllers.get(sessionId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}

export const dispatcher = createDispatcher({ run: runSession });
