import type {
  AlertGroupContext,
  NormalizedAlert,
  SessionAlert,
  SessionMeta,
} from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import { getDb, type Db } from "../db.js";
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
    session_id: sessionId,
    group_key: groupKey,
    source_alert_id: alert.sourceAlertId,
    labels: JSON.stringify(alert.labels),
    alert_type: alert.alertType,
    fired_at: alert.firedAt,
    arrived_at: arrivedAt,
    cleared_at: null,
    injected: injected ? 1 : 0,
    pending_delivery: injected ? 1 : 0,
    dropped_alerts: delivery.droppedAlerts,
    group_context:
      delivery.groupContext === null
        ? null
        : JSON.stringify(delivery.groupContext),
    alert: JSON.stringify(alert),
  };
}

function parseAlert(raw: string): NormalizedAlert[] {
  try {
    return [JSON.parse(raw) as NormalizedAlert];
  } catch {
    return [];
  }
}

/* The unique index skips an alert already held and still firing, which is what
   recognises Alertmanager's repeats and the second copy from an HA pair. */
async function insertAlerts(
  db: Db,
  sessionId: string,
  groupKey: string,
  alerts: NormalizedAlert[],
  injected: boolean,
  delivery: DeliveryContext,
): Promise<NormalizedAlert[]> {
  const arrivedAt = new Date().toISOString();
  const rows = await db
    .insertInto("alerts")
    .values(
      alerts.map((alert) =>
        alertRow(sessionId, groupKey, alert, arrivedAt, injected, delivery),
      ),
    )
    .onConflict((oc) => oc.doNothing())
    .returning("alert")
    .execute();
  return rows.flatMap((r) => parseAlert(r.alert));
}

/* What a delivery came to. `none` stored nothing new, `joined` added to its
   group's open session, and `started` and `held` opened one. */
export type Admission =
  | { kind: "none" }
  | {
      kind: "joined" | "started" | "held";
      sessionId: string;
      alerts: NormalizedAlert[];
    };

/* One transaction over SQLite's one connection, so no two deliveries both read
   the hour's count under the limit, and no session opens owning no alert. */
export async function admitDelivery(
  meta: SessionMeta,
  groupKey: string,
  alerts: NormalizedAlert[],
  delivery: DeliveryContext,
  perHour: number,
): Promise<Admission> {
  if (alerts.length === 0) return { kind: "none" };
  return await getDb()
    .transaction()
    .execute(async (trx): Promise<Admission> => {
      // The sender's group key decides what joins, never a relationship we infer.
      const open = await trx
        .selectFrom("alerts as a")
        .innerJoin("sessions as s", "s.session_id", "a.session_id")
        .select(["a.session_id as sessionId", "s.status"])
        .where("a.group_key", "=", groupKey)
        .where("s.status", "in", ["running", "action_required", "not_started"])
        .executeTakeFirst();
      if (open !== undefined) {
        // A session nobody has started opens on all its alerts, so none is news.
        const joined = await insertAlerts(
          trx,
          open.sessionId,
          groupKey,
          alerts,
          open.status !== "not_started",
          delivery,
        );
        return joined.length === 0
          ? { kind: "none" }
          : { kind: "joined", sessionId: open.sessionId, alerts: joined };
      }

      const window = await trx
        .selectFrom("sessions")
        .select((eb) => eb.fn.countAll<number>().as("started"))
        .where("investigation", "=", 1)
        .where("held_reason", "is", null)
        .where("created_at", ">=", new Date(Date.now() - HOUR_MS).toISOString())
        .executeTakeFirst();
      const started = window?.started ?? 0;
      const heldReason =
        started >= perHour
          ? `${started} investigations started on their own in the past hour, the most Settings → Limits allows.`
          : null;
      const { sessionId } = meta;
      await trx
        .insertInto("sessions")
        .values({
          session_id: sessionId,
          title: meta.title,
          investigation: 1,
          held_reason: heldReason,
          created_at: meta.createdAt,
          last_activity_at: meta.createdAt,
        })
        .execute();
      const opened = await insertAlerts(
        trx,
        sessionId,
        groupKey,
        alerts,
        false,
        delivery,
      );
      if (opened.length === 0) {
        await trx
          .deleteFrom("sessions")
          .where("session_id", "=", sessionId)
          .execute();
        return { kind: "none" };
      }
      if (heldReason !== null) {
        await refreshSessionStatus(sessionId, trx);
        return { kind: "held", sessionId, alerts: opened };
      }
      await claimRun(sessionId, trx);
      return { kind: "started", sessionId, alerts: opened };
    });
}

/* Keyed the way the unique index keys, so a recovery clears the firing it names
   rather than an older one sharing the fingerprint. */
export async function markAlertCleared(
  sourceAlertId: string,
  firedAt: string,
  clearedAt: string,
): Promise<string[]> {
  const rows = await getDb()
    .updateTable("alerts")
    .set({ cleared_at: clearedAt })
    .where("source_alert_id", "=", sourceAlertId)
    .where("fired_at", "=", firedAt)
    .where("cleared_at", "is", null)
    .returning("session_id as sessionId")
    .execute();
  // The last alert clearing is what makes a session read as resolved.
  const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
  for (const sessionId of sessionIds) await refreshSessionStatus(sessionId);
  return sessionIds;
}

// The alerts that joined a run and that its model has not yet been told of.
export async function pendingAlerts(
  sessionId: string,
): Promise<{ id: number; alert: NormalizedAlert }[]> {
  const rows = await getDb()
    .selectFrom("alerts")
    .select(["id", "alert"])
    .where("session_id", "=", sessionId)
    .where("pending_delivery", "=", 1)
    .orderBy("id", "asc")
    .execute();
  return rows.flatMap((r) =>
    parseAlert(r.alert).map((alert) => ({ id: r.id, alert })),
  );
}

export async function markAlertsDelivered(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .updateTable("alerts")
    .set({ pending_delivery: 0 })
    .where("id", "in", ids)
    .execute();
}

interface AlertRow {
  sessionId: string;
  arrivedAt: string;
  clearedAt: string | null;
  injected: number;
  droppedAlerts: number;
  groupContext: string | null;
  alert: string;
}

// Untrusted on read for the same reason as the canonical column below: a session
// holding one unreadable alert should still open, showing the rest.
function toSessionAlert(row: AlertRow): SessionAlert[] {
  try {
    return [
      {
        alert: JSON.parse(row.alert) as NormalizedAlert,
        arrivedAt: row.arrivedAt,
        clearedAt: row.clearedAt,
        injected: row.injected === 1,
        droppedAlerts: row.droppedAlerts,
        groupContext:
          row.groupContext === null
            ? null
            : (JSON.parse(row.groupContext) as AlertGroupContext),
      },
    ];
  } catch {
    return [];
  }
}

const ALERT_COLUMNS = [
  "session_id as sessionId",
  "arrived_at as arrivedAt",
  "cleared_at as clearedAt",
  "injected",
  "dropped_alerts as droppedAlerts",
  "group_context as groupContext",
  "alert",
] as const;

// id ascending is arrival order, which is what the first alert of a batch means
// to everything that reads one.
export async function alertsFor(sessionId: string): Promise<SessionAlert[]> {
  const rows = await getDb()
    .selectFrom("alerts")
    .select(ALERT_COLUMNS)
    .where("session_id", "=", sessionId)
    .orderBy("id", "asc")
    .execute();
  return rows.flatMap(toSessionAlert);
}

// One query for a whole page of sessions, rather than a correlated subquery per
// row: the page is bounded, so this is two statements however long the list is.
export async function alertsForMany(
  sessionIds: string[],
): Promise<Map<string, SessionAlert[]>> {
  const byId = new Map<string, SessionAlert[]>();
  if (sessionIds.length === 0) return byId;
  const rows = await getDb()
    .selectFrom("alerts")
    .select(ALERT_COLUMNS)
    .where("session_id", "in", sessionIds)
    .orderBy("id", "asc")
    .execute();
  for (const row of rows) {
    const entries = byId.get(row.sessionId) ?? [];
    entries.push(...toSessionAlert(row));
    byId.set(row.sessionId, entries);
  }
  return byId;
}

// What the reconciler works through: every session with an alert still firing.
export async function sessionIdsWithOpenAlerts(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("alerts")
    .select("session_id as sessionId")
    .distinct()
    .where("cleared_at", "is", null)
    .orderBy("session_id")
    .execute();
  return rows.map((r) => r.sessionId);
}
