import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  AWAITING_KINDS,
  FAILURE_KINDS,
  INVESTIGATION_STATUSES,
  REMINDER_KINDS,
  TRANSCRIPT_KINDS,
} from "@nightwarden/shared";
import type {
  AlertGroupContext,
  Candidate,
  ElicitationAnswerPart,
  Finding,
  MessagePart,
  NormalizedAlert,
  SubmittedReport,
  ToolApprovalPart,
} from "@nightwarden/shared";
import { user } from "../auth/schema.js";
import type { Stage } from "../agent/loop/stage.js";
import type { ToolResult } from "../llm/types.js";
import { inList } from "../schema-helpers.js";

// A person's answer to a gate and how long the gate waited.
export interface Decision {
  part: ToolApprovalPart | ElicitationAnswerPart;
  waitedMs: number;
}

/* The answers to a turn a gate interrupted, held until every call in it has one.
   The stage rides along because the calls before the gate can move it. */
export interface OpenTurn {
  stage: Stage;
  results: ToolResult[];
  decisions: Decision[];
}

export const sessions = sqliteTable(
  "sessions",
  {
    sessionId: text("session_id").primaryKey(),
    title: text("title").notNull().default(""),
    investigation: integer("investigation", { mode: "boolean" })
      .notNull()
      .default(false),
    // Only 'running' is claimed, by a conditional UPDATE that is the dispatch mutex.
    status: text("status", { enum: INVESTIGATION_STATUSES })
      .notNull()
      .default("completed"),
    // Why the hourly limit held it; kept after a Start so the count skips it.
    heldReason: text("held_reason"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    failureKind: text("failure_kind", { enum: FAILURE_KINDS }),
    stoppedAt: text("stopped_at"),
    // The gate, all null when the session is not parked on one.
    awaitingToolUseId: text("awaiting_tool_use_id"),
    awaitingKind: text("awaiting_kind", { enum: AWAITING_KINDS }),
    // When the gate opened, so a decision can say how long it waited.
    awaitingSince: text("awaiting_since"),
    openTurn: text("open_turn", { mode: "json" }).$type<OpenTurn>(),
    candidates: text("candidates", { mode: "json" })
      .$type<Candidate[]>()
      .notNull()
      .default(sql`'[]'`),
    findings: text("findings", { mode: "json" })
      .$type<Finding[]>()
      .notNull()
      .default(sql`'[]'`),
    report: text("report", { mode: "json" }).$type<SubmittedReport>(),
    recordUpdatedAt: text("record_updated_at"),
    // The person who started a chat; null for an investigation.
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "cascade",
    }),
    createdAt: text("created_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
  },
  (t) => [
    check(
      "sessions_status",
      sql`${t.status} IN (${inList(INVESTIGATION_STATUSES)})`,
    ),
    check(
      "sessions_failure_kind",
      sql`${t.failureKind} IN (${inList(FAILURE_KINDS)})`,
    ),
    check(
      "sessions_awaiting_kind",
      sql`${t.awaitingKind} IN (${inList(AWAITING_KINDS)})`,
    ),
    index("idx_sessions_list").on(
      t.investigation,
      sql`(${t.awaitingToolUseId} IS NOT NULL) DESC`,
      sql`${t.lastActivityAt} DESC`,
      t.sessionId,
    ),
    // Serves one person's chat list, in the same order as idx_sessions_list.
    index("idx_sessions_creator").on(
      t.investigation,
      t.createdBy,
      sql`(${t.awaitingToolUseId} IS NOT NULL) DESC`,
      sql`${t.lastActivityAt} DESC`,
      t.sessionId,
    ),
  ],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull(),
    sourceAlertId: text("source_alert_id").notNull(),
    // Its own column so json_each reads the labels without the alert beside them.
    labels: text("labels", { mode: "json" })
      .$type<NormalizedAlert["labels"]>()
      .notNull()
      .default(sql`'{}'`),
    firedAt: text("fired_at").notNull(),
    arrivedAt: text("arrived_at").notNull(),
    clearedAt: text("cleared_at"),
    injected: integer("injected", { mode: "boolean" }).notNull().default(false),
    // True while an alert that joined a run waits for the model to be told of it.
    pendingDelivery: integer("pending_delivery", { mode: "boolean" })
      .notNull()
      .default(false),
    droppedAlerts: integer("dropped_alerts").notNull().default(0),
    groupContext: text("group_context", {
      mode: "json",
    }).$type<AlertGroupContext>(),
    alert: text("alert", { mode: "json" }).$type<NormalizedAlert>().notNull(),
  },
  (t) => [
    index("idx_alerts_session").on(t.sessionId, t.id),
    uniqueIndex("idx_alerts_firing")
      .on(t.sourceAlertId, t.firedAt)
      .where(sql`${t.clearedAt} IS NULL`),
    index("idx_alerts_open")
      .on(t.sessionId)
      .where(sql`${t.clearedAt} IS NULL`),
    index("idx_alerts_group").on(t.groupKey),
  ],
);

export const sessionTranscript = sqliteTable(
  "session_transcript",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: TRANSCRIPT_KINDS }).notNull(),
    content: text("content").notNull(),
    canonical: text("canonical", { mode: "json" }).$type<{
      parts: MessagePart[];
    }>(),
    timestamp: text("timestamp").notNull(),
    // The sender's id for a person's message; null on every other row.
    clientId: text("client_id"),
    // Which note a system_reminder row is; null on every other kind.
    reminder: text("reminder", { enum: REMINDER_KINDS }),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.seq] }),
    check(
      "session_transcript_kind",
      sql`${t.kind} IN (${inList(TRANSCRIPT_KINDS)})`,
    ),
    check(
      "session_transcript_reminder",
      sql`${t.reminder} IN (${inList(REMINDER_KINDS)})`,
    ),
  ],
);

// A citable result past the ceiling, kept whole so the agent can page through it.
export const toolResultStore = sqliteTable(
  "tool_result_store",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.toolCallId] })],
);
