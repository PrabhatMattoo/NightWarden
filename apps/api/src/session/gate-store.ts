import { and, eq, isNotNull } from "drizzle-orm";
import type { AwaitingKind } from "@nightwarden/shared";
import { getDb } from "../db.js";
import type { ToolResult } from "../llm/types.js";
import { type Decision, type OpenTurn, sessions } from "./schema.js";
import { claimRun, refreshSessionStatus } from "./status-store.js";

// The gate a session is parked on: columns on its own row, since there is at
// most one. A decision waits on the open turn, then lands on the transcript.
export interface PendingHumanInput {
  sessionId: string;
  toolCallId: string;
  kind: AwaitingKind;
  askedAt: string;
}

export function deletePendingHumanInput(sessionId: string): boolean {
  const cleared = getDb()
    .update(sessions)
    .set({
      awaitingToolUseId: null,
      awaitingKind: null,
      awaitingSince: null,
    })
    .where(
      and(
        eq(sessions.sessionId, sessionId),
        isNotNull(sessions.awaitingToolUseId),
      ),
    )
    .run();
  if (cleared.changes === 0) return false;
  // Nothing is being asked any more, so 'action_required' has stopped being true.
  refreshSessionStatus(sessionId);
  return true;
}

/* Settles the gate and claims the run together, so a crash cannot leave a
   session reading completed with nothing resuming it. False means nothing changed. */
export function resolveGate(
  sessionId: string,
  toolCallId: string,
  decision: Decision,
  result: ToolResult | null,
): boolean {
  return getDb().transaction((tx) => {
    const parked = tx
      .select({ turn: sessions.openTurn })
      .from(sessions)
      .where(
        and(
          eq(sessions.sessionId, sessionId),
          eq(sessions.awaitingToolUseId, toolCallId),
        ),
      )
      .get();
    if (parked === undefined) return false;
    // Every gate on a tool call is parked with its turn; only a check-in has none.
    if (parked.turn === null) {
      throw new Error(`gate ${toolCallId} on ${sessionId} has no open turn`);
    }
    if (!claimRun(sessionId, tx)) return false;
    const { turn } = parked;
    tx.update(sessions)
      .set({
        awaitingToolUseId: null,
        awaitingKind: null,
        awaitingSince: null,
        openTurn: {
          ...turn,
          results: result === null ? turn.results : [...turn.results, result],
          decisions: [...turn.decisions, decision],
        },
        lastActivityAt: new Date().toISOString(),
      })
      .where(eq(sessions.sessionId, sessionId))
      .run();
    return true;
  });
}

export function getOpenTurn(sessionId: string): OpenTurn | null {
  return (
    getDb()
      .select({ turn: sessions.openTurn })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .get()?.turn ?? null
  );
}

export function getPendingHumanInputBySessionId(
  sessionId: string,
): PendingHumanInput | undefined {
  const row = getDb()
    .select({
      toolCallId: sessions.awaitingToolUseId,
      kind: sessions.awaitingKind,
      askedAt: sessions.awaitingSince,
    })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .get();
  if (row?.toolCallId == null || row.kind === null || row.askedAt === null) {
    return undefined;
  }
  return {
    sessionId,
    toolCallId: row.toolCallId,
    kind: row.kind,
    askedAt: row.askedAt,
  };
}

export function hasPendingHumanInput(sessionId: string): boolean {
  return (
    getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(
        and(
          eq(sessions.sessionId, sessionId),
          isNotNull(sessions.awaitingToolUseId),
        ),
      )
      .get() !== undefined
  );
}
