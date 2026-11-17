/* A generic OpenAI-compatible server's chat completions as a fetch: it refuses a tool call left
   unanswered, as Ollama and vLLM do, and streams scripted turns as chunks, reasoning in `reasoning_content`. */
import {
  data,
  isTitle,
  sentMessages,
  streamedReply,
  toolNames,
  unpairedToolCall,
  type ChatMessage,
  type ChatRequest,
} from "./fake-chat-completions.js";
import {
  fakeModel,
  type FakeModel,
  type ScriptedTurn,
  type WireCodec,
} from "./fake-model.js";

const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  404: "not_found_error",
  429: "rate_limit_error",
};

const chunk = (n: number, delta: object, finish: string | null): object => ({
  id: `chatcmpl-${n}`,
  object: "chat.completion.chunk",
  created: 1_794_000_000,
  model: "local-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function refused(
  status: number,
  message: string,
  retryAfterSeconds?: number,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: ERROR_TYPES[status] ?? "server_error",
        param: null,
        code: null,
      },
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

type CompatibleMessage = ChatMessage & { reasoning_content?: string };

interface CompatibleRequest extends ChatRequest {
  messages: CompatibleMessage[];
}

export type FakeOpenAICompatible = FakeModel<CompatibleRequest>;

function openAICompatibleCodec(): WireCodec<CompatibleRequest> {
  let generations = 0;
  let thoughts = 0;
  return {
    parse: (body) => JSON.parse(body) as CompatibleRequest,
    isTitle,
    refusal: (request) => unpairedToolCall(request.messages),
    reply: (scripted) => {
      const n = ++generations;
      // A thinking model on these servers reasons before it calls a tool.
      const opening =
        scripted.toolUses.length > 0
          ? [
              chunk(
                n,
                { reasoning_content: `Thought ${++thoughts}: picking a tool.` },
                null,
              ),
            ]
          : [];
      return streamedReply(
        scripted,
        (delta, finish) => chunk(n, delta, finish),
        opening,
      );
    },
    overloadedAfter: (text) =>
      data(chunk(++generations, { role: "assistant", content: text }, null), {
        error: { message: "Overloaded", type: "server_error", code: 502 },
      }),
    stalledOpening: (text) =>
      `data: ${JSON.stringify(chunk(++generations, { role: "assistant", content: text }, null))}\n\n`,
    refused,
    sent: (request) =>
      sentMessages(request, (message) =>
        message.reasoning_content === undefined
          ? []
          : [message.reasoning_content],
      ),
    tools: toolNames,
  };
}

export function fakeOpenAICompatible(
  initial: ScriptedTurn[] = [],
): FakeOpenAICompatible {
  return fakeModel(openAICompatibleCodec(), initial);
}
