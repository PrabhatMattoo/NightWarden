import { getDb } from "../db.js";

// Keyed by the call, so a retried call replaces its own copy rather than adding one.
export async function storeToolResult(
  sessionId: string,
  toolCallId: string,
  content: string,
): Promise<void> {
  await getDb()
    .insertInto("tool_result_store")
    .values({ session_id: sessionId, tool_call_id: toolCallId, content })
    .onConflict((oc) =>
      oc.columns(["session_id", "tool_call_id"]).doUpdateSet({ content }),
    )
    .execute();
}

export async function readToolResult(
  sessionId: string,
  toolCallId: string,
): Promise<string | undefined> {
  const row = await getDb()
    .selectFrom("tool_result_store")
    .select("content")
    .where("session_id", "=", sessionId)
    .where("tool_call_id", "=", toolCallId)
    .executeTakeFirst();
  return row?.content;
}
