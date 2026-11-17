import { APICallError, jsonSchema, streamText, tool } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ModelCheck } from "@nightwarden/shared";

// A local server may load the model from disk before its first token.
const MODEL_CHECK_TIMEOUT_MS = 60_000;

// Reasoning shares the budget, so a model that thinks first still reaches its call.
const MODEL_CHECK_MAX_OUTPUT_TOKENS = 2048;

const MAX_DETAIL_CHARS = 300;

const TOOLS = {
  Ping: tool({
    description: "Confirms the model can call a tool. Takes no arguments.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
  }),
};

function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_DETAIL_CHARS);
}

function failureOf(err: unknown): ModelCheck {
  const status = APICallError.isInstance(err) ? err.statusCode : undefined;
  if (status === 401 || status === 403) return { ok: false, reason: "bad_key" };
  const detail = detailOf(err);
  // A status means the server answered and said no; anything else never answered.
  return status === undefined
    ? { ok: false, reason: "unreachable", detail }
    : { ok: false, reason: "refused", detail };
}

/* One streamed turn, the path a run takes, offering one tool with no handler.
   A model that answers in words instead cannot run an investigation. */
export async function checkModelCallsTool(
  model: LanguageModelV4,
): Promise<ModelCheck> {
  try {
    const result = streamText({
      model,
      prompt: "Call the Ping tool now.",
      tools: TOOLS,
      maxOutputTokens: MODEL_CHECK_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS),
      onError: () => {},
    });
    let called = false;
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error;
      if (part.type === "tool-call") called = true;
    }
    return called ? { ok: true } : { ok: false, reason: "no_tool_call" };
  } catch (err) {
    return failureOf(err);
  }
}
