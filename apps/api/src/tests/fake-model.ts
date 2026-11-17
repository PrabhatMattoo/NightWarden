// The model every loop test talks to: the AI SDK's own mock, scripted turn by turn.
import { APICallError, StreamProviderError } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { ModelFor } from "../llm/factory.js";
import type { StopReason, ToolUse } from "../llm/types.js";

// One reply, as the model would stream it. A reply that calls a tool reasons first.
interface ScriptedReply {
  toolUses: ToolUse[];
  text: string;
  // No provider streams a stop reason meaning an error, so none is scripted.
  stopReason?: Exclude<StopReason, "error">;
}

export type ScriptedTurn =
  | ScriptedReply
  // An HTTP refusal; the SDK retries it on 429 and 5xx.
  | { status: number; retryAfterSeconds?: number }
  // The request never reaches a server.
  | { unreachable: true }
  // The reply streams `text`, then the provider sheds load part way.
  | { text: string; overloadedAfter: true }
  // The reply streams `text`, then goes silent until the request is abandoned.
  | { text: string; stall: true };

// One message as a provider-neutral reading of the prompt; consecutive turns of one role are merged.
export interface SentMessage {
  role: "user" | "assistant";
  texts: string[];
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>;
  // The handles of the reasoning the model issued that this message carries back.
  reasoning: string[];
}

export interface FakeModel {
  model: MockLanguageModelV4;
  // Hands `model` to whatever builds one in production.
  modelFor: ModelFor;
  // Every call that reached it, title calls apart, so an index is a turn.
  requests: LanguageModelV4CallOptions[];
  titleRequests: LanguageModelV4CallOptions[];
  // Replaces the script; its last turn repeats once the rest are spent.
  script: (turns: ScriptedTurn[]) => void;
  // Parks each turn on `gate` until the test releases it; no argument stops parking.
  park: (gate?: () => Promise<void>) => void;
  // What the next title requests are answered with, in order.
  titles: (...replies: ScriptedReply[]) => void;
}

const DEFAULT_TURN: ScriptedReply = { toolUses: [], text: "Done." };
const NO_TITLE: ScriptedReply = { toolUses: [], text: "" };

const FINISH_REASONS: Readonly<
  Record<Exclude<StopReason, "error">, LanguageModelV4FinishReason>
> = {
  done: { unified: "stop", raw: "end_turn" },
  tools: { unified: "tool-calls", raw: "tool_use" },
  length: { unified: "length", raw: "max_tokens" },
  filtered: { unified: "content-filter", raw: "refusal" },
  paused: { unified: "stop", raw: "pause_turn" },
  unknown: { unified: "other", raw: "not_yet_published" },
};

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const streamOf = (
  chunks: LanguageModelV4StreamPart[],
): ReadableStream<LanguageModelV4StreamPart> =>
  simulateReadableStream({
    chunks,
    initialDelayInMs: null,
    chunkDelayInMs: null,
  });

function textParts(id: string, text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

function replyParts(
  reply: ScriptedReply,
  n: number,
): LanguageModelV4StreamPart[] {
  const reasoning: LanguageModelV4StreamPart[] =
    reply.toolUses.length > 0
      ? [
          { type: "reasoning-start", id: `r-${n}` },
          {
            type: "reasoning-delta",
            id: `r-${n}`,
            delta: `Weighing ${reply.toolUses.map((u) => u.name).join(", ")}.`,
          },
          {
            type: "reasoning-end",
            id: `r-${n}`,
            providerMetadata: { scripted: { handle: `thought-${n}` } },
          },
        ]
      : [];
  const stop =
    reply.stopReason ?? (reply.toolUses.length > 0 ? "tools" : "done");
  return [
    ...reasoning,
    ...(reply.text ? textParts(`t-${n}`, reply.text) : []),
    ...reply.toolUses.map((use): LanguageModelV4StreamPart => ({
      type: "tool-call",
      toolCallId: use.toolCallId,
      toolName: use.name,
      input: JSON.stringify(use.input),
    })),
    { type: "finish", usage: USAGE, finishReason: FINISH_REASONS[stop] },
  ];
}

function refusal(
  status: number,
  retryAfterSeconds: number | undefined,
): APICallError {
  return new APICallError({
    message: "scripted refusal",
    url: "https://model.test/v1",
    requestBodyValues: {},
    statusCode: status,
    isRetryable: status === 429 || status >= 500,
    ...(retryAfterSeconds !== undefined && {
      responseHeaders: { "retry-after": String(retryAfterSeconds) },
    }),
  });
}

// Shaped as the Anthropic adapter reports an overloaded_error that arrives mid-stream.
const OVERLOADED = new StreamProviderError({
  message: "Overloaded",
  type: "overloaded_error",
  statusCode: 529,
  isRetryable: true,
  data: { type: "overloaded_error", message: "Overloaded" },
});

// Rejects the way a request does once its signal fires.
function abortable<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function respond(
  turn: ScriptedTurn,
  n: number,
  signal: AbortSignal | undefined,
): ReadableStream<LanguageModelV4StreamPart> {
  if ("status" in turn) throw refusal(turn.status, turn.retryAfterSeconds);
  if ("unreachable" in turn) {
    throw new APICallError({
      message: "Cannot connect to API: fetch failed",
      url: "https://model.test/v1",
      requestBodyValues: {},
      isRetryable: true,
    });
  }
  if ("overloadedAfter" in turn) {
    return streamOf([
      ...textParts(`t-${n}`, turn.text),
      { type: "error", error: OVERLOADED },
    ]);
  }
  if ("stall" in turn) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-start", id: `t-${n}` });
        controller.enqueue({
          type: "text-delta",
          id: `t-${n}`,
          delta: turn.text,
        });
        signal?.addEventListener("abort", () =>
          controller.error(signal.reason),
        );
      },
    });
  }
  return streamOf(replyParts(turn, n));
}

const callIds = (
  message: LanguageModelV4Prompt[number] | undefined,
): string[] =>
  message?.role === "assistant"
    ? message.content.flatMap((part) =>
        part.type === "tool-call" ? [part.toolCallId] : [],
      )
    : [];

const resultIds = (
  message: LanguageModelV4Prompt[number] | undefined,
): string[] =>
  message?.role === "tool"
    ? message.content.flatMap((part) =>
        part.type === "tool-result" ? [part.toolCallId] : [],
      )
    : [];

/* Every provider refuses a result that answers no call. The SDK refuses the
   opposite, a call left unanswered, before the model is asked. */
function strayToolResult(prompt: LanguageModelV4Prompt): string | null {
  for (const [i, message] of prompt.entries()) {
    const called = callIds(prompt[i - 1]);
    const stray = resultIds(message).find((id) => !called.includes(id));
    if (stray !== undefined) {
      return `Tool result ${stray} answers no call in the message before it.`;
    }
  }
  return null;
}

const isTitle = (options: LanguageModelV4CallOptions): boolean =>
  options.tools?.some((tool) => tool.name === "SetTitle") === true;

function sentMessage(message: LanguageModelV4Prompt[number]): SentMessage[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      return [
        {
          role: "user",
          texts: message.content.flatMap((p) =>
            p.type === "text" ? [p.text] : [],
          ),
          toolUses: [],
          toolResults: [],
          reasoning: [],
        },
      ];
    case "assistant":
      return [
        {
          role: "assistant",
          texts: message.content.flatMap((p) =>
            p.type === "text" ? [p.text] : [],
          ),
          toolUses: message.content.flatMap((p) =>
            p.type === "tool-call"
              ? [{ id: p.toolCallId, name: p.toolName, input: p.input }]
              : [],
          ),
          toolResults: [],
          reasoning: message.content.flatMap((p) => {
            if (p.type !== "reasoning") return [];
            const handle = p.providerOptions?.["scripted"]?.["handle"];
            return typeof handle === "string" ? [handle] : [];
          }),
        },
      ];
    case "tool":
      return [
        {
          role: "user",
          texts: [],
          toolUses: [],
          toolResults: message.content.flatMap((p) =>
            p.type === "tool-result"
              ? [
                  {
                    toolUseId: p.toolCallId,
                    content:
                      "value" in p.output && typeof p.output.value === "string"
                        ? p.output.value
                        : JSON.stringify(p.output),
                    isError: p.output.type === "error-text",
                  },
                ]
              : [],
          ),
          reasoning: [],
        },
      ];
  }
}

// A tool result and the text beside it are one user turn to a provider.
function merged(messages: SentMessage[]): SentMessage[] {
  const out: SentMessage[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last?.role !== message.role) {
      out.push(message);
      continue;
    }
    last.texts.push(...message.texts);
    last.toolUses.push(...message.toolUses);
    last.toolResults.push(...message.toolResults);
    last.reasoning.push(...message.reasoning);
  }
  return out;
}

export function fakeModel(initial: ScriptedTurn[] = []): FakeModel {
  const requests: LanguageModelV4CallOptions[] = [];
  const titleRequests: LanguageModelV4CallOptions[] = [];
  const titleReplies: ScriptedReply[] = [];
  let script = initial;
  let next = 0;
  let replies = 0;
  let gate: (() => Promise<void>) | undefined;

  const handle = async (
    options: LanguageModelV4CallOptions,
  ): Promise<{ stream: ReadableStream<LanguageModelV4StreamPart> }> => {
    const n = ++replies;
    if (isTitle(options)) {
      titleRequests.push(options);
      return {
        stream: streamOf(replyParts(titleReplies.shift() ?? NO_TITLE, n)),
      };
    }
    requests.push(options);
    const stray = strayToolResult(options.prompt);
    if (stray !== null) {
      throw new APICallError({
        message: stray,
        url: "https://model.test/v1",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });
    }
    if (gate) await gate();
    const turn = script[next++] ?? script[script.length - 1] ?? DEFAULT_TURN;
    return { stream: respond(turn, n, options.abortSignal) };
  };

  const model = new MockLanguageModelV4({
    doStream: (options) => abortable(options.abortSignal, handle(options)),
  });

  return {
    model,
    modelFor: () => model,
    requests,
    titleRequests,
    script: (turns) => {
      script = turns;
      next = 0;
    },
    park: (parkOn) => {
      gate = parkOn;
    },
    titles: (...replies) => {
      titleReplies.push(...replies);
    },
  };
}

// The conversation one request carried, read off the prompt.
export function messagesSentTo(fake: FakeModel, call = 0): SentMessage[] {
  const request = fake.requests[call];
  return request === undefined
    ? []
    : merged(request.prompt.flatMap(sentMessage));
}

// The tool names one request offered.
export function toolsSentTo(fake: FakeModel, call = 0): string[] {
  return (fake.requests[call]?.tools ?? []).map((tool) => tool.name);
}

interface GateController {
  gate: () => Promise<void>;
  releaseNext: () => void;
  releaseAll: () => void;
  // How many turns are parked. A run reaches its gate asynchronously, so a test
  // that releases before anything is waiting releases nothing.
  waiting: () => number;
  // An investigation parks more times than its script has turns, and a test about
  // dispatch should not count them. Real timers only.
  releaseUntil: (
    done: () => boolean | Promise<boolean>,
    timeoutMs?: number,
  ) => Promise<void>;
}

// A FIFO gate: each parked turn waits for releaseNext() or releaseAll().
export function createGateController(): GateController {
  const pending: Array<() => void> = [];
  const releaseAll = (): void => {
    const copy = [...pending];
    pending.length = 0;
    for (const resolve of copy) resolve();
  };
  return {
    gate: () => new Promise<void>((resolve) => pending.push(resolve)),
    releaseNext: () => pending.shift()?.(),
    releaseAll,
    waiting: () => pending.length,
    releaseUntil: async (done, timeoutMs = 10_000) => {
      const began = Date.now();
      while (!(await done())) {
        if (Date.now() - began > timeoutMs) {
          throw new Error("releaseUntil timed out");
        }
        releaseAll();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}
