import { and, asc, count, eq, gte, inArray, isNull } from "drizzle-orm";
import type {
  NormalizedAlert,
  SessionAlert,
  SessionMeta,
} from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import { getDb, type Db } from "../db.js";
import { alerts, sessions } from "./schema.js";
import { claimRun, refreshSessionStatus } from "./status-store.js";

// Every alert row, and the one transaction that decides which session an
// arriving alert belongs to and whether that session starts.

const HOUR_MS = 60 * 60_000;

// Denormalised onto every alert the delivery carried, so each row reads whole
// without the delivery beside it.
function alertRow(
  sessionId: string,
  groupKey: string,
  alert: NormalizedAlert,
  arrivedAt: string,
  injected: boolean,
  delivery: DeliveryContext,
) {
  return {
    sessionId,
    groupKey,
    sourceAlertId: alert.sourceAlertId,
    labels: alert.labels,
    alertType: alert.alertType,
    firedAt: alert.firedAt,
    arrivedAt,
    clearedAt: null,
    injected,
    pendingDelivery: injected,
    droppedAlerts: delivery.droppedAlerts,
    groupContext: delivery.groupContext,
    alert,
  };
}

/* The unique index skips an alert already held and still firing, which is what
   recognises Alertmanager's repeats and the second copy from an HA pair. */
function insertAlerts(
  sessionId: string,
  groupKey: string,
  incoming: NormalizedAlert[],
  injected: boolean,
  delivery: DeliveryContext,
  db: Db,
): NormalizedAlert[] {
  const arrivedAt = new Date().toISOString();
  return db
    .insert(alerts)
    .values(
      incoming.map((alert) =>
        alertRow(sessionId, groupKey, alert, arrivedAt, injected, delivery),
      ),
    )
    .onConflictDoNothing()
    .returning({ alert: alerts.alert })
    .all()
    .map((r) => r.alert);
}

/* What a delivery came to. `none` stored nothing new, `joined` added to its
   group's open session, and `started` and `held` opened one. */
type Admission =
  | { kind: "none" }
  | {
      kind: "joined" | "started" | "held";
      sessionId: string;
      alerts: NormalizedAlert[];
    };

/* One transaction over SQLite's one connection, so no two deliveries both read
   the hour's count under the limit, and no session opens owning no alert. */
export function admitDelivery(
  meta: SessionMeta,
  groupKey: string,
  incoming: NormalizedAlert[],
  delivery: DeliveryContext,
  perHour: number,
): Admission {
  if (incoming.length === 0) return { kind: "none" };
  return getDb().transaction((tx): Admission => {
    // The sender's group key decides what joins, never a relationship we infer.
    const open = tx
      .select({ sessionId: alerts.sessionId, status: sessions.status })
      .from(alerts)
      .innerJoin(sessions, eq(sessions.sessionId, alerts.sessionId))
      .where(
        and(
          eq(alerts.groupKey, groupKey),
          inArray(sessions.status, [
            "running",
            "action_required",
            "not_started",
          ]),
        ),
      )
      .get();
    if (open !== undefined) {
      // A session nobody has started opens on all its alerts, so none is news.
      const joined = insertAlerts(
        open.sessionId,
        groupKey,
        incoming,
        open.status !== "not_started",
        delivery,
        tx,
      );
      return joined.length === 0
        ? { kind: "none" }
        : { kind: "joined", sessionId: open.sessionId, alerts: joined };
    }

    const window = tx
      .select({ started: count() })
      .from(sessions)
      .where(
        and(
          eq(sessions.investigation, true),
          isNull(sessions.heldReason),
          gte(sessions.createdAt, new Date(Date.now() - HOUR_MS).toISOString()),
        ),
      )
      .get();
    const started = window?.started ?? 0;
    const heldReason =
      started >= perHour
        ? `${started} investigations started on their own in the past hour, the most Settings → Limits allows.`
        : null;
    const { sessionId } = meta;
    tx.insert(sessions)
      .values({
        sessionId,
        title: meta.title,
        investigation: true,
        heldReason,
        createdAt: meta.createdAt,
        lastActivityAt: meta.createdAt,
      })
      .run();
    const opened = insertAlerts(
      sessionId,
      groupKey,
      incoming,
      false,
      delivery,
      tx,
    );
    if (opened.length === 0) {
      tx.delete(sessions).where(eq(sessions.sessionId, sessionId)).run();
      return { kind: "none" };
    }
    if (heldReason !== null) {
      refreshSessionStatus(sessionId, tx);
      return { kind: "held", sessionId, alerts: opened };
    }
    claimRun(sessionId, tx);
    return { kind: "started", sessionId, alerts: opened };
  });
}

/* Keyed the way the unique index keys, so a recovery clears the firing it names
   rather than an older one sharing the fingerprint. */
export function markAlertCleared(
  sourceAlertId: string,
  firedAt: string,
  clearedAt: string,
): string[] {
  const rows = getDb()
    .update(alerts)
    .set({ clearedAt })
    .where(
      and(
        eq(alerts.sourceAlertId, sourceAlertId),
        eq(alerts.firedAt, firedAt),
        isNull(alerts.clearedAt),
      ),
    )
    .returning({ sessionId: alerts.sessionId })
    .all();
  // The last alert clearing is what makes a session read as resolved.
  const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
  for (const sessionId of sessionIds) refreshSessionStatus(sessionId);
  return sessionIds;
}

// The alerts that joined a run and that its model has not yet been told of.
export function pendingAlerts(
  sessionId: string,
): { id: number; alert: NormalizedAlert }[] {
  return getDb()
    .select({ id: alerts.id, alert: alerts.alert })
    .from(alerts)
    .where(
      and(eq(alerts.sessionId, sessionId), eq(alerts.pendingDelivery, true)),
    )
    .orderBy(asc(alerts.id))
    .all();
}

export function markAlertsDelivered(ids: number[]): void {
  if (ids.length === 0) return;
  getDb()
    .update(alerts)
    .set({ pendingDelivery: false })
    .where(inArray(alerts.id, ids))
    .run();
}

const SESSION_ALERT_COLUMNS = {
  arrivedAt: alerts.arrivedAt,
  clearedAt: alerts.clearedAt,
  injected: alerts.injected,
  droppedAlerts: alerts.droppedAlerts,
  groupContext: alerts.groupContext,
  alert: alerts.alert,
};

// id ascending is arrival order, which is what the first alert of a batch means
// to everything that reads one.
export function alertsFor(sessionId: string): SessionAlert[] {
  return getDb()
    .select(SESSION_ALERT_COLUMNS)
    .from(alerts)
    .where(eq(alerts.sessionId, sessionId))
    .orderBy(asc(alerts.id))
    .all();
}

// One query for a whole page of sessions, rather than a correlated subquery per
// row: the page is bounded, so this is two statements however long the list is.
export function alertsForMany(
  sessionIds: string[],
): Map<string, SessionAlert[]> {
  const byId = new Map<string, SessionAlert[]>();
  if (sessionIds.length === 0) return byId;
  const rows = getDb()
    .select({ sessionId: alerts.sessionId, ...SESSION_ALERT_COLUMNS })
    .from(alerts)
    .where(inArray(alerts.sessionId, sessionIds))
    .orderBy(asc(alerts.id))
    .all();
  for (const { sessionId, ...alert } of rows) {
    const entries = byId.get(sessionId) ?? [];
    entries.push(alert);
    byId.set(sessionId, entries);
  }
  return byId;
}

// What the reconciler works through: every session with an alert still firing.
export function sessionIdsWithOpenAlerts(): string[] {
  return getDb()
    .selectDistinct({ sessionId: alerts.sessionId })
    .from(alerts)
    .where(isNull(alerts.clearedAt))
    .orderBy(asc(alerts.sessionId))
    .all()
    .map((r) => r.sessionId);
}
