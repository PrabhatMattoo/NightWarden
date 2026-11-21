import { and, eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { toolResultStore } from "./schema.js";

// Keyed by the call, so a retried call replaces its own copy rather than adding one.
export function storeToolResult(
  sessionId: string,
  toolCallId: string,
  content: string,
): void {
  getDb()
    .insert(toolResultStore)
    .values({ sessionId, toolCallId, content })
    .onConflictDoUpdate({
      target: [toolResultStore.sessionId, toolResultStore.toolCallId],
      set: { content },
    })
    .run();
}

export function readToolResult(
  sessionId: string,
  toolCallId: string,
): string | undefined {
  return getDb()
    .select({ content: toolResultStore.content })
    .from(toolResultStore)
    .where(
      and(
        eq(toolResultStore.sessionId, sessionId),
        eq(toolResultStore.toolCallId, toolCallId),
      ),
    )
    .get()?.content;
}
