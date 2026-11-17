/* What every Chat Completions server shares, which OpenRouter and a generic OpenAI-compatible
   server each build their fake from: reading a request, refusing a tool call left unanswered, and chunked replies. */
import type { StopReason, ToolUse } from "../llm/types.js";
import type { ScriptedReply, SentMessage } from "./fake-model.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

// The request body exactly as the server receives it.
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
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

const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
};

// Bare data lines, closed on [DONE].
export const data = (...chunks: object[]): string =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
  "data: [DONE]\n\n";

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => part.text ?? "").join("\n");

export const isTitle = (request: ChatRequest): boolean =>
  request.tools?.some((tool) => tool.function.name === "SetTitle") === true;

export const toolNames = (request: ChatRequest): string[] =>
  (request.tools ?? []).map((tool) => tool.function.name);

/* The 400s the API returns for a tool call and its answer that do not pair up,
   worded as it words them: a tool message answers a call just before it, and
   each call of an assistant message is answered. */
export function unpairedToolCall(messages: ChatMessage[]): string | null {
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
  return null;
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

export type ChunkOf = (delta: object, finish: string | null) => object;

// A scripted turn as chunks: a role, what `opening` adds, the text, each call, then the finish with usage.
export function streamedReply(
  scripted: ScriptedReply,
  chunkOf: ChunkOf,
  opening: object[] = [],
): string {
  const chunks = [
    chunkOf({ role: "assistant", content: "" }, null),
    ...opening,
  ];
  if (scripted.text) chunks.push(chunkOf({ content: scripted.text }, null));
  scripted.toolUses.forEach((use, index) =>
    chunks.push(chunkOf(toolCallDelta(index, use), null)),
  );
  const stop =
    scripted.stopReason ?? (scripted.toolUses.length > 0 ? "tools" : "done");
  if (stop === "paused") {
    throw new Error("Chat Completions has no paused finish reason to script");
  }
  chunks.push({ ...chunkOf({}, FINISH[stop]), usage: USAGE });
  return data(...chunks);
}

// The conversation one request carried; `reasoning` reads whatever handles a server hands back.
export function sentMessages<M extends ChatMessage>(
  request: { messages: M[] },
  reasoning: (message: M) => string[] = () => [],
): SentMessage[] {
  return request.messages.flatMap((message): SentMessage[] => {
    const blank = { texts: [], toolUses: [], toolResults: [], reasoning: [] };
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
        reasoning: reasoning(message),
      },
    ];
  });
}
