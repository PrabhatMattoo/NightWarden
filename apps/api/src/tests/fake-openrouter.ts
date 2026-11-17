/* OpenRouter's chat completions as a fetch, routed to a Claude model: it reads each request
   as OpenRouter would, refuses what it and Anthropic refuse, and streams scripted turns as its chunks. */
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
  type ScriptedReply,
  type ScriptedTurn,
  type WireCodec,
} from "./fake-model.js";

interface ReasoningDetail {
  type: string;
  text?: string;
  signature?: string;
  format?: string;
}

type OpenRouterMessage = ChatMessage & {
  reasoning_details?: ReasoningDetail[];
};

interface OpenRouterRequest extends ChatRequest {
  messages: OpenRouterMessage[];
  // Present when the run asked the model to reason; Claude is only sent thinking when it is.
  reasoning?: unknown;
}

const chunk = (n: number, delta: object, finish: string | null): object => ({
  id: `gen-${n}`,
  object: "chat.completion.chunk",
  created: 1_794_000_000,
  model: "anthropic/claude-sonnet-4.5",
  provider: "Anthropic",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/* What the chat-completions API refuses about tool calls, and Anthropic's rule
   that the latest tool-calling turn returns its signed thinking unmodified. */
function refusalOf(
  request: OpenRouterRequest,
  issued: Map<string, ReasoningDetail>,
): string | null {
  const unpaired = unpairedToolCall(request.messages);
  if (unpaired !== null) return unpaired;
  const latest = request.messages.filter((m) => m.role === "assistant").at(-1);
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

export type FakeOpenRouter = FakeModel<OpenRouterRequest>;

function openRouterCodec(): WireCodec<OpenRouterRequest> {
  const issued = new Map<string, ReasoningDetail>();
  let generations = 0;
  let thoughts = 0;
  function reply(scripted: ScriptedReply, request: OpenRouterRequest): string {
    const n = ++generations;
    const opening: object[] = [];
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
      opening.push(
        chunk(n, { reasoning: detail.text, reasoning_details: [detail] }, null),
      );
    }
    return streamedReply(
      scripted,
      (delta, finish) => chunk(n, delta, finish),
      opening,
    );
  }

  return {
    parse: (body) => JSON.parse(body) as OpenRouterRequest,
    isTitle,
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
      sentMessages(request, (message) =>
        (message.reasoning_details ?? []).flatMap((d) =>
          d.signature === undefined ? [] : [d.signature],
        ),
      ),
    tools: toolNames,
  };
}

export function fakeOpenRouter(initial: ScriptedTurn[] = []): FakeOpenRouter {
  return fakeModel(openRouterCodec(), initial);
}
