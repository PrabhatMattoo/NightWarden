/* Anthropic's Messages API as a fetch: it reads each request as Anthropic would,
   refuses what Anthropic refuses with its 400, and streams scripted turns as its SSE events. */
import type { StopReason, ToolUse } from "../llm/types.js";
import {
  fakeModel,
  sse,
  type FakeModel,
  type ScriptedTurn,
  type SentMessage,
  type WireCodec,
} from "./fake-model.js";

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | ToolUseBlock
  | ToolResultBlock
  | { type: string };

interface WireMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

// The request body exactly as Anthropic receives it.
interface AnthropicRequest {
  model: string;
  system?: unknown;
  messages: WireMessage[];
  tools?: Array<{ name: string }>;
  stream?: boolean;
  [key: string]: unknown;
}

const STOP_REASONS: Readonly<Record<Exclude<StopReason, "error">, string>> = {
  done: "end_turn",
  tools: "tool_use",
  length: "max_tokens",
  filtered: "refusal",
  paused: "pause_turn",
  unknown: "a_reason_not_yet_published",
};

const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  529: "overloaded_error",
};

const start = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
};

function textBlock(index: number, text: string): object[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index },
  ];
}

function thinkingBlock(
  index: number,
  thinking: string,
  signature: string,
): object[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature },
    },
    { type: "content_block_stop", index },
  ];
}

function toolUseBlock(index: number, use: ToolUse): object[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: use.toolCallId,
        name: use.name,
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(use.input),
      },
    },
    { type: "content_block_stop", index },
  ];
}

function finish(stopReason: string): object[] {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
}

// What Anthropic sends when it sheds load after the reply has begun.
const overloadedAfter = (said: string): string =>
  sse(start, ...textBlock(0, said), {
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  });

function blocksOf(message: WireMessage): Block[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

const toolUseIds = (message: WireMessage | undefined): string[] =>
  message?.role === "assistant"
    ? blocksOf(message).flatMap((b) =>
        b.type === "tool_use" ? [(b as ToolUseBlock).id] : [],
      )
    : [];

const toolResultIds = (message: WireMessage | undefined): string[] =>
  message?.role === "user"
    ? blocksOf(message).flatMap((b) =>
        b.type === "tool_result" ? [(b as ToolResultBlock).tool_use_id] : [],
      )
    : [];

interface IssuedThinking {
  thinking: string;
  signature: string;
}

/* The 400s the Messages API documents for a conversation's shape, worded as it
   words them. Consecutive turns of one role are merged, by the adapter and by Anthropic. */
function refusalOf(
  body: AnthropicRequest,
  issued: Map<string, IssuedThinking>,
): string | null {
  const { messages } = body;
  for (const [i, message] of messages.entries()) {
    const blocks = blocksOf(message);
    if (
      blocks.some(
        (b) => b.type === "text" && (b as { text: string }).text === "",
      )
    ) {
      return `messages.${i}: text content blocks must be non-empty`;
    }
    const answered = toolResultIds(messages[i + 1]);
    const unanswered = toolUseIds(message).filter(
      (id) => !answered.includes(id),
    );
    if (unanswered.length > 0) {
      return `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${unanswered.join(", ")}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
    }
    const called = toolUseIds(messages[i - 1]);
    const stray = toolResultIds(message).find((id) => !called.includes(id));
    if (stray !== undefined) {
      return `messages.${i}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${stray}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
    }
    const firstOther = blocks.findIndex((b) => b.type !== "tool_result");
    if (
      firstOther !== -1 &&
      blocks.slice(firstOther).some((b) => b.type === "tool_result")
    ) {
      return `messages.${i}: \`tool_result\` blocks must come first in the content, before any other block.`;
    }
  }
  // During tool use the latest assistant turn goes back with its thinking unmodified.
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  const latest = messages[lastAssistant];
  const thought = toolUseIds(latest)
    .map((id) => issued.get(id))
    .find((t) => t !== undefined);
  if (latest !== undefined && thought !== undefined) {
    const first = blocksOf(latest)[0] as Partial<IssuedThinking> & {
      type: string;
    };
    if (first.type !== "thinking") {
      return `messages.${lastAssistant}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`${first.type}\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block.`;
    }
    if (
      first.signature !== thought.signature ||
      first.thinking !== thought.thinking
    ) {
      return `messages.${lastAssistant}.content.0: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified.`;
    }
  }
  return null;
}

function refused(
  status: number,
  message: string,
  retryAfterSeconds?: number,
): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: ERROR_TYPES[status] ?? "api_error", message },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        ...(retryAfterSeconds !== undefined && {
          "retry-after": String(retryAfterSeconds),
        }),
      },
    },
  );
}

function resultText(content: ToolResultBlock["content"]): string {
  return typeof content === "string"
    ? content
    : content.map((part) => part.text ?? "").join("\n");
}

// The conversation one request carried, read off the wire.
export type FakeAnthropic = FakeModel<AnthropicRequest>;

function anthropicCodec(): WireCodec<AnthropicRequest> {
  const issued = new Map<string, IssuedThinking>();
  let thoughts = 0;
  return {
    parse: (body) => JSON.parse(body) as AnthropicRequest,
    isTitle: (request) =>
      request.tools?.some((tool) => tool.name === "SetTitle") === true,
    refusal: (request) => refusalOf(request, issued),
    reply: (reply) => {
      const events: object[] = [start];
      let index = 0;
      if (reply.toolUses.length > 0) {
        const thinking = `Weighing ${reply.toolUses.map((u) => u.name).join(", ")}.`;
        const signature = `sig-${++thoughts}`;
        for (const use of reply.toolUses)
          issued.set(use.toolCallId, { thinking, signature });
        events.push(...thinkingBlock(index++, thinking, signature));
      }
      if (reply.text) events.push(...textBlock(index++, reply.text));
      for (const use of reply.toolUses)
        events.push(...toolUseBlock(index++, use));
      const stop =
        reply.stopReason ?? (reply.toolUses.length > 0 ? "tools" : "done");
      events.push(...finish(STOP_REASONS[stop]));
      return sse(...events);
    },
    overloadedAfter,
    stalledOpening: (text) => sse(start, ...textBlock(0, text).slice(0, 2)),
    refused,
    sent: (request) =>
      request.messages.map((message): SentMessage => {
        const blocks = blocksOf(message);
        return {
          role: message.role,
          texts: blocks.flatMap((b) =>
            b.type === "text" ? [(b as { text: string }).text] : [],
          ),
          toolUses: blocks.flatMap((b) => {
            if (b.type !== "tool_use") return [];
            const use = b as ToolUseBlock;
            return [{ id: use.id, name: use.name, input: use.input }];
          }),
          toolResults: blocks.flatMap((b) => {
            if (b.type !== "tool_result") return [];
            const result = b as ToolResultBlock;
            return [
              {
                toolUseId: result.tool_use_id,
                content: resultText(result.content),
                isError: result.is_error === true,
              },
            ];
          }),
          reasoning: blocks.flatMap((b) =>
            b.type === "thinking" ? [(b as IssuedThinking).signature] : [],
          ),
        };
      }),
    tools: (request) => (request.tools ?? []).map((tool) => tool.name),
  };
}

export function fakeAnthropic(initial: ScriptedTurn[] = []): FakeAnthropic {
  return fakeModel(anthropicCodec(), initial);
}
