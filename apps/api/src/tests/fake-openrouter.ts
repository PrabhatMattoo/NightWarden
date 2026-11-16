/* OpenRouter's chat completions as a fetch, routed to a Claude model: it reads each request
   as OpenRouter would, refuses what it and Anthropic refuse, and streams scripted turns as its chunks. */
import type { StopReason, ToolUse } from "../llm/types.js";
import {
  fakeModel,
  type FakeModel,
  type ScriptedReply,
  type ScriptedTurn,
  type SentMessage,
  type WireCodec,
} from "./fake-model.js";

interface ReasoningDetail {
  type: string;
  text?: string;
  signature?: string;
  format?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_details?: ReasoningDetail[];
}

// The request body exactly as OpenRouter receives it.
export interface OpenRouterRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
  // Present when the run asked the model to reason; Claude is only sent thinking when it is.
  reasoning?: unknown;
  [key: string]: unknown;
}

const FINISH: Readonly<
  Record<Exclude<StopReason, "error" | "paused">, string>
> = {
  done: "stop",
  tools: "tool_calls",
  length: "length",
  filtered: "content_filter",
  unknown: "a_reason_not_yet_published",
};

const chunk = (n: number, delta: object, finish: string | null): object => ({
  id: `gen-${n}`,
  object: "chat.completion.chunk",
  created: 1_794_000_000,
  model: "anthropic/claude-sonnet-4.5",
  provider: "Anthropic",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

// OpenRouter streams bare data lines and closes on [DONE].
const data = (...chunks: object[]): string =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
  "data: [DONE]\n\n";

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => part.text ?? "").join("\n");

/* What the chat-completions API refuses about tool calls, worded as it words them,
   and Anthropic's rule that the latest tool-calling turn returns its signed thinking unmodified. */
function refusalOf(
  request: OpenRouterRequest,
  issued: Map<string, ReasoningDetail>,
): string | null {
  const { messages } = request;
  for (const [i, message] of messages.entries()) {
    if (message.role === "tool") {
      let j = i - 1;
      while (messages[j]?.role === "tool") j--;
      const calls = messages[j]?.tool_calls?.map((call) => call.id) ?? [];
      if (!calls.includes(message.tool_call_id ?? "")) {
        return "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.";
      }
    }
    const calls = message.tool_calls?.map((call) => call.id) ?? [];
    const answered = new Set<string>();
    for (let j = i + 1; messages[j]?.role === "tool"; j++)
      answered.add(messages[j]?.tool_call_id ?? "");
    const unanswered = calls.filter((id) => !answered.has(id));
    if (unanswered.length > 0) {
      return `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${unanswered.join(", ")}`;
    }
  }
  const latest = messages.filter((m) => m.role === "assistant").at(-1);
  const thought = latest?.tool_calls
    ?.map((call) => issued.get(call.id))
    .find((t) => t !== undefined);
  if (thought !== undefined) {
    const back = latest?.reasoning_details?.find(
      (d) => d.type === "reasoning.text",
    );
    if (back?.signature !== thought.signature || back?.text !== thought.text) {
      return "messages: When `thinking` is enabled, a final `assistant` message must start with a thinking block, and its thinking cannot be modified. Pass back reasoning_details unmodified.";
    }
  }
  return null;
}

function refused(
  status: number,
  message: string,
  retryAfterSeconds?: number,
): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfterSeconds !== undefined && {
        "retry-after": String(retryAfterSeconds),
      }),
    },
  });
}

function toolCallDelta(index: number, use: ToolUse): object {
  return {
    tool_calls: [
      {
        index,
        id: use.toolCallId,
        type: "function",
        function: { name: use.name, arguments: JSON.stringify(use.input) },
      },
    ],
  };
}

export type FakeOpenRouter = FakeModel<OpenRouterRequest>;

function openRouterCodec(): WireCodec<OpenRouterRequest> {
  const issued = new Map<string, ReasoningDetail>();
  let generations = 0;
  let thoughts = 0;
  function reply(scripted: ScriptedReply, request: OpenRouterRequest): string {
    const n = ++generations;
    const chunks: object[] = [
      chunk(n, { role: "assistant", content: "" }, null),
    ];
    if (request.reasoning !== undefined && scripted.toolUses.length > 0) {
      const thought = ++thoughts;
      // Never repeated word for word, as a model's is not: the adapter de-duplicates details by text.
      const detail = {
        type: "reasoning.text",
        text: `Thought ${thought}: weighing ${scripted.toolUses.map((u) => u.name).join(", ")}.`,
        signature: `sig-${thought}`,
        format: "anthropic-claude-v1",
        index: 0,
      };
      for (const use of scripted.toolUses) issued.set(use.toolCallId, detail);
      chunks.push(
        chunk(n, { reasoning: detail.text, reasoning_details: [detail] }, null),
      );
    }
    if (scripted.text) chunks.push(chunk(n, { content: scripted.text }, null));
    scripted.toolUses.forEach((use, index) =>
      chunks.push(chunk(n, toolCallDelta(index, use), null)),
    );
    const stop =
      scripted.stopReason ?? (scripted.toolUses.length > 0 ? "tools" : "done");
    if (stop === "paused") {
      throw new Error("OpenRouter has no paused finish reason to script");
    }
    chunks.push({ ...chunk(n, {}, FINISH[stop]), usage: USAGE });
    return data(...chunks);
  }

  return {
    parse: (body) => JSON.parse(body) as OpenRouterRequest,
    isTitle: (request) =>
      request.tools?.some((tool) => tool.function.name === "SetTitle") === true,
    refusal: (request) => refusalOf(request, issued),
    reply,
    overloadedAfter: (text) => {
      const n = ++generations;
      return data(chunk(n, { role: "assistant", content: text }, null), {
        error: { code: 502, message: "Overloaded" },
      });
    },
    stalledOpening: (text) =>
      `data: ${JSON.stringify(chunk(++generations, { role: "assistant", content: text }, null))}\n\n`,
    refused,
    sent: (request) =>
      request.messages.flatMap((message): SentMessage[] => {
        const blank = {
          texts: [],
          toolUses: [],
          toolResults: [],
          reasoning: [],
        };
        if (message.role === "tool") {
          const result = {
            toolUseId: message.tool_call_id ?? "",
            content: textOf(message.content),
            isError: false,
          };
          return [{ role: "user", ...blank, toolResults: [result] }];
        }
        if (message.role === "system") return [];
        const text = textOf(message.content);
        return [
          {
            role: message.role,
            ...blank,
            texts: text ? [text] : [],
            toolUses: (message.tool_calls ?? []).map((call) => ({
              id: call.id,
              name: call.function.name,
              input: JSON.parse(call.function.arguments) as unknown,
            })),
            reasoning: (message.reasoning_details ?? []).flatMap((d) =>
              d.signature === undefined ? [] : [d.signature],
            ),
          },
        ];
      }),
    tools: (request) => (request.tools ?? []).map((tool) => tool.function.name),
  };
}

export function fakeOpenRouter(initial: ScriptedTurn[] = []): FakeOpenRouter {
  return fakeModel(openRouterCodec(), initial);
}
