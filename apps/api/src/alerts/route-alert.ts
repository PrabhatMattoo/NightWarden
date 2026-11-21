import { randomUUID } from "node:crypto";
import type { NormalizedAlert } from "@nightwarden/shared";
import type { DeliveryContext } from "./delivery.js";
import { buildSessionMeta } from "../agent/loop/run-session.js";
import { loadConfig } from "../config/store.js";
import { admitDelivery } from "../session/alerts-store.js";
import type { Dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";
import { publishSessionOpened } from "../session/stream.js";

interface Routed {
  stored: number;
  skipped: number;
}

// One webhook is one group, routed whole: regrouping on our own clock would
// replace the user's group_by with a guess.
export function routeDelivery(
  dispatcher: Dispatcher,
  groupKey: string,
  firing: NormalizedAlert[],
  // Required, not defaulted: a caller that forgets it silently tells every
  // investigation the group arrived whole and unexplained.
  delivery: DeliveryContext,
): Routed {
  const { maxInvestigationsPerHour } = loadConfig();
  const admission = admitDelivery(
    buildSessionMeta(randomUUID(), firing[0] ?? null, undefined),
    groupKey,
    firing,
    delivery,
    maxInvestigationsPerHour,
  );
  const stored = admission.kind === "none" ? 0 : admission.alerts.length;
  const skipped = firing.length - stored;
  // Repeats are ordinary - Alertmanager re-sends on repeat_interval - but a
  // silent drop is what makes a reused fingerprint invisible in a test.
  if (skipped > 0)
    logger.info({ groupKey, skipped }, "duplicate alerts dropped");
  if (admission.kind === "none") return { stored, skipped };

  const { kind, sessionId, alerts } = admission;
  logger.info(
    { groupKey, sessionId, alertCount: stored },
    kind === "joined"
      ? "alerts joined the investigation already covering this group"
      : kind === "started"
        ? "alert group opened an investigation"
        : "alert group held by the hourly limit for a person to start",
  );
  if (kind !== "joined") publishSessionOpened(sessionId);
  if (kind === "started") dispatcher.launch({ sessionId, alerts });
  return { stored, skipped };
}
