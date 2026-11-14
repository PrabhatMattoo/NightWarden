import { sessionIdsWithOpenAlerts } from "../session/alerts-store.js";
import { runFailure } from "../session/status-store.js";
import { getSession } from "../session/store.js";
import { dispatcher } from "../dispatcher.js";
import { buildSeed } from "../session/seed.js";
import { loadConfig } from "../config/store.js";
import { logger } from "../logger.js";
import { type ConditionCache, verifyRecovery } from "./recovery.js";

// Nothing here detects that a fix happened, since a bash call may only have
// read. It asks about every open condition, less and less often.

interface Step {
  // The oldest an alert can be for this step to apply.
  withinMs: number;
  everyMs: number;
}

const MINUTE = 60_000;

// Stopped after a day: past that nobody is watching this run, and the webhook
// still answers instantly if the condition ever does clear.
const SCHEDULE: readonly Step[] = [
  { withinMs: 15 * MINUTE, everyMs: MINUTE },
  { withinMs: 75 * MINUTE, everyMs: 5 * MINUTE },
  { withinMs: 24 * 60 * MINUTE, everyMs: 30 * MINUTE },
];

export const RECONCILE_TICK_MS = MINUTE;

// In memory on purpose: a restart costs one extra round of questions, and the
// alternative is a column that exists only to describe a schedule.
const lastAsked = new Map<string, number>();

// Anchored on the session, not the alert's firedAt: an alert firing for a
// month is new to an install that just ingested it.
async function watchingSince(sessionId: string): Promise<number> {
  const created = (await getSession(sessionId))?.createdAt;
  return created === undefined ? Date.now() : new Date(created).getTime();
}

function due(sessionId: string, ageMs: number, now: number): boolean {
  const step = SCHEDULE.find((s) => ageMs < s.withinMs);
  if (step === undefined) return false;
  const last = lastAsked.get(sessionId);
  return last === undefined || now - last >= step.everyMs;
}

// Keeps the map the size of the work rather than the size of the history.
function forgetSettled(open: Set<string>): void {
  for (const sessionId of lastAsked.keys()) {
    if (!open.has(sessionId)) lastAsked.delete(sessionId);
  }
}

/* Sequential rather than parallel: these are the same few rules on one
   Prometheus, which needs no burst of concurrent requests mid-incident. */
export async function reconcileRecovery(
  now = Date.now(),
): Promise<{ asked: number; cleared: number; retried: number }> {
  const result = { asked: 0, cleared: 0, retried: 0 };
  const sessionIds = await sessionIdsWithOpenAlerts();
  forgetSettled(new Set(sessionIds));
  const answered: ConditionCache = new Map();

  for (const sessionId of sessionIds) {
    if (!due(sessionId, now - (await watchingSince(sessionId)), now)) continue;
    lastAsked.set(sessionId, now);
    result.asked++;
    try {
      if ((await verifyRecovery(sessionId, answered)) === "confirmed") {
        result.cleared++;
        continue;
      }
      if (await retryFailedRun(sessionId)) result.retried++;
    } catch (err) {
      // One unreachable source must not stop the rest of the sweep.
      logger.warn({ err, sessionId }, "recovery reconciler: session skipped");
    }
  }
  return result;
}

// Rides this sweep: the sessions worth retrying are the ones worth asking
// about. Never a permanent failure, which fails identically every time.
async function retryFailedRun(sessionId: string): Promise<boolean> {
  const failure = await runFailure(sessionId);
  if (failure === undefined) return false;
  if (failure.kind !== "transient") return false;
  // The provider retry count under Settings: past that the thing is not a blip.
  const { maxRetries } = await loadConfig();
  if (failure.attempts >= maxRetries) return false;

  const started = await dispatcher.dispatch({
    sessionId,
    seed: await buildSeed(sessionId),
  });
  if (started) {
    logger.info(
      { sessionId, attempt: failure.attempts + 1, of: maxRetries },
      "retrying a run that failed on a transient error",
    );
  }
  return started;
}
