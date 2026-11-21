import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { AwaitingKind } from "@nightwarden/shared";
import { getDb } from "../db.js";
import type { ToolResult } from "../llm/types.js";
import { sessions } from "./schema.js";
import { refreshSessionStatus } from "./status-store.js";

// The gate a session is parked on: four columns on its own row, since there is
// at most one. What a person decided lives on the transcript, which is durable.
export interface PendingHumanInput {
  sessionId: string;
  toolCallId: string;
  kind: AwaitingKind;
  completedResults: ToolResult[];
  claimedAt?: string | null;
}

// Claiming stamps when an attempt began, which is what a boot after a crash
// reads to tell "nobody answered" from "a write may already have run".
export function claimPendingHumanInput(sessionId: string): boolean {
  return (
    getDb()
      .update(sessions)
      .set({ attemptStartedAt: new Date().toISOString() })
      .where(
        and(
          eq(sessions.sessionId, sessionId),
          isNotNull(sessions.awaitingToolUseId),
          isNull(sessions.attemptStartedAt),
        ),
      )
      .run().changes > 0
  );
}

export function deletePendingHumanInput(sessionId: string): boolean {
  const cleared = getDb()
    .update(sessions)
    .set({
      awaitingToolUseId: null,
      awaitingKind: null,
      awaitingResults: [],
      attemptStartedAt: null,
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

export function getPendingHumanInputBySessionId(
  sessionId: string,
): PendingHumanInput | undefined {
  const row = getDb()
    .select({
      toolCallId: sessions.awaitingToolUseId,
      kind: sessions.awaitingKind,
      completedResults: sessions.awaitingResults,
      claimedAt: sessions.attemptStartedAt,
    })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .get();
  if (row?.toolCallId == null || row.kind === null) return undefined;
  return {
    sessionId,
    toolCallId: row.toolCallId,
    kind: row.kind,
    completedResults: row.completedResults,
    claimedAt: row.claimedAt,
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
