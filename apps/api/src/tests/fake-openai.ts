/* OpenAI's Responses API as a fetch: it reads each request's input items as OpenAI would,
   refuses what OpenAI refuses with its 400, and streams scripted turns as its response events. */
import type { StopReason, ToolUse } from "../llm/types.js";
import {
  fakeModel,
  sse,
  type FakeModel,
  type ScriptedReply,
  type ScriptedTurn,
  type SentMessage,
  type WireCodec,
} from "./fake-model.js";

interface InputItem {
  type?: string;
  role?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string | Array<{ type: string; text?: string }>;
  content?: string | Array<{ type: string; text?: string }>;
}

// The request body exactly as OpenAI receives it.
interface OpenAIRequest {
  model: string;
  input: InputItem[];
  tools?: Array<{ name: string }>;
  [key: string]: unknown;
}

// What a response leaves stored, so a later item_reference can name it. `store` defaults to true.
type Issued = { kind: "reasoning" } | { kind: "message"; text: string };

// An unknown reason reads as the turn ending for a reason nobody named, which is the point.
const INCOMPLETE: Readonly<
  Record<Exclude<StopReason, "error" | "paused">, string | null>
> = {
  done: null,
  tools: null,
  length: "max_output_tokens",
  filtered: "content_filter",
  unknown: "a_reason_not_yet_published",
};

const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "invalid_request_error",
  403: "invalid_request_error",
  404: "invalid_request_error",
  429: "tokens",
  500: "server_error",
  503: "server_error",
};

const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 0 },
};

const created = (n: number): object => ({
  type: "response.created",
  response: { id: `resp_${n}`, created_at: 1_794_000_000, model: "gpt-5" },
});

function messageItem(index: number, id: string, text: string): object[] {
  const item = { type: "message", id, role: "assistant" };
  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: index,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: index,
      item: {
        ...item,
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
  ];
}

// No summary was asked for, so the item streams as an id with nothing to read, as OpenAI sends it.
function reasoningItem(index: number, id: string): object[] {
  const item = { type: "reasoning", id, encrypted_content: null, summary: [] };
  return [
    { type: "response.output_item.added", output_index: index, item },
    { type: "response.output_item.done", output_index: index, item },
  ];
}

function functionCallItem(index: number, id: string, use: ToolUse): object[] {
  const item = {
    type: "function_call",
    id,
    call_id: use.toolCallId,
    name: use.name,
  };
  const args = JSON.stringify(use.input);
  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: id,
      output_index: index,
      delta: args,
    },
    {
      type: "response.output_item.done",
      output_index: index,
      item: { ...item, arguments: args, status: "completed" },
    },
  ];
}

const textOf = (content: InputItem["content"] | InputItem["output"]): string =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => part.text ?? "").join("\n");

/* The 400s the Responses API returns for an input's shape, worded as it words them.
   A call and its output are matched by call_id, wherever each sits in the input. */
function refusalOf(
  request: OpenAIRequest,
  issued: Map<string, Issued>,
): string | null {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const item of request.input) {
    if (item.type === "item_reference" && !issued.has(item.id ?? "")) {
      return `Item with id '${item.id}' not found.`;
    }
    if (item.type === "function_call") calls.add(item.call_id ?? "");
    if (item.type === "function_call_output") {
      if (!calls.has(item.call_id ?? "")) {
        return `No tool call found for function call output with call_id ${item.call_id}.`;
      }
      outputs.add(item.call_id ?? "");
    }
  }
  const unanswered = [...calls].find((id) => !outputs.has(id));
  return unanswered === undefined
    ? null
    : `No tool output found for function call ${unanswered}.`;
}

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

export type FakeOpenAI = FakeModel<OpenAIRequest>;

function openAICodec(): WireCodec<OpenAIRequest> {
  const issued = new Map<string, Issued>();
  let responses = 0;
  let items = 0;

  function reply(scripted: ScriptedReply): string {
    const n = ++responses;
    const events: object[] = [created(n)];
    let index = 0;
    if (scripted.toolUses.length > 0) {
      const id = `rs_${++items}`;
      issued.set(id, { kind: "reasoning" });
      events.push(...reasoningItem(index++, id));
    }
    if (scripted.text) {
      const id = `msg_${++items}`;
      issued.set(id, { kind: "message", text: scripted.text });
      events.push(...messageItem(index++, id, scripted.text));
    }
    for (const use of scripted.toolUses)
      events.push(...functionCallItem(index++, `fc_${++items}`, use));
    const stop =
      scripted.stopReason ?? (scripted.toolUses.length > 0 ? "tools" : "done");
    if (stop === "paused") {
      throw new Error("the Responses API has no paused stop reason to script");
    }
    const reason = INCOMPLETE[stop];
    events.push({
      type: reason === null ? "response.completed" : "response.incomplete",
      response: {
        incomplete_details: reason === null ? null : { reason },
        usage: USAGE,
      },
    });
    return sse(...events);
  }

  function sentItem(item: InputItem): SentMessage | null {
    const blank = { texts: [], toolUses: [], toolResults: [], reasoning: [] };
    if (item.type === "item_reference") {
      const stored = issued.get(item.id ?? "");
      if (stored?.kind === "reasoning")
        return { role: "assistant", ...blank, reasoning: [item.id ?? ""] };
      return { role: "assistant", ...blank, texts: [stored?.text ?? ""] };
    }
    if (item.type === "reasoning")
      return { role: "assistant", ...blank, reasoning: [item.id ?? ""] };
    if (item.type === "function_call") {
      const use = {
        id: item.call_id ?? "",
        name: item.name ?? "",
        input: JSON.parse(item.arguments ?? "{}") as unknown,
      };
      return { role: "assistant", ...blank, toolUses: [use] };
    }
    if (item.type === "function_call_output") {
      const result = {
        toolUseId: item.call_id ?? "",
        content: textOf(item.output),
        isError: false,
      };
      return { role: "user", ...blank, toolResults: [result] };
    }
    if (item.role === "user" || item.role === "assistant")
      return { role: item.role, ...blank, texts: [textOf(item.content)] };
    return null;
  }

  return {
    parse: (body) => JSON.parse(body) as OpenAIRequest,
    isTitle: (request) =>
      request.tools?.some((tool) => tool.name === "SetTitle") === true,
    refusal: (request) => refusalOf(request, issued),
    reply,
    overloadedAfter: (text) =>
      sse(
        created(++responses),
        ...messageItem(0, `msg_${++items}`, text).slice(0, 2),
        {
          type: "error",
          sequence_number: 4,
          code: "server_error",
          message: "The server had an error while processing your request.",
          param: null,
        },
      ),
    stalledOpening: (text) =>
      sse(
        created(++responses),
        ...messageItem(0, `msg_${++items}`, text).slice(0, 2),
      ),
    refused,
    sent: (request) =>
      request.input.flatMap((item) => {
        const message = sentItem(item);
        return message === null ? [] : [message];
      }),
    tools: (request) => (request.tools ?? []).map((tool) => tool.name),
  };
}

export function fakeOpenAI(initial: ScriptedTurn[] = []): FakeOpenAI {
  return fakeModel(openAICodec(), initial);
}
