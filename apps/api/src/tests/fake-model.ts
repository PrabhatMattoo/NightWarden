// A provider's API as a fetch. Each wire file supplies the codec; this holds what every wire shares.
import type { StopReason, ToolUse } from "../llm/types.js";

// One reply, as the model would stream it. A reply that calls a tool reasons first.
export interface ScriptedReply {
  toolUses: ToolUse[];
  text: string;
  // No provider streams a stop reason meaning an error, so none is scripted.
  stopReason?: Exclude<StopReason, "error">;
}

export type ScriptedTurn =
  | ScriptedReply
  // An HTTP refusal, with the error type the provider gives that status.
  | { status: number; retryAfterSeconds?: number }
  // The reply streams `text`, then the provider sheds load part way.
  | { text: string; overloadedAfter: true }
  // The reply streams `text`, then goes silent until the request is abandoned.
  | { text: string; stall: true };

// One message as a provider-neutral reading of the wire; consecutive turns of one role are merged.
export interface SentMessage {
  role: "user" | "assistant";
  texts: string[];
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>;
  // The handles of the reasoning the model issued that this message carries back.
  reasoning: string[];
}

export interface WireCodec<Request> {
  parse(body: string): Request;
  isTitle(request: Request): boolean;
  // The 400 the provider documents for this request's shape, or null.
  refusal(request: Request): string | null;
  reply(reply: ScriptedReply, request: Request): string;
  overloadedAfter(text: string): string;
  // The opening events of a reply that then falls silent.
  stalledOpening(text: string): string;
  refused(
    status: number,
    message: string,
    retryAfterSeconds?: number,
  ): Response;
  sent(request: Request): SentMessage[];
  tools(request: Request): string[];
}

export interface FakeModel<Request = unknown> {
  fetch: typeof fetch;
  // Every request that reached it, title requests apart, so an index is a turn.
  requests: Request[];
  titleRequests: Request[];
  // Replaces the script; its last turn repeats once the rest are spent.
  script: (turns: ScriptedTurn[]) => void;
  // Parks each turn on `gate` until the test releases it; no argument stops parking.
  park: (gate?: () => Promise<void>) => void;
  // What the next title requests are answered with, in order.
  titles: (...replies: ScriptedReply[]) => void;
  sent: (call: number) => SentMessage[];
  tools: (call: number) => string[];
}

const DEFAULT_TURN: ScriptedReply = { toolUses: [], text: "Done." };
const NO_TITLE: ScriptedReply = { toolUses: [], text: "" };

const streamed = (body: BodyInit): Response =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });

export const sse = (...events: object[]): string =>
  events
    .map(
      (e) =>
        `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`,
    )
    .join("");

// Rejects the way fetch does once the request's signal fires.
function abortable<T>(
  signal: AbortSignal | null | undefined,
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

// Anthropic merges consecutive turns of one role, so the other wires read the same way.
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

export function fakeModel<Request extends { tools?: unknown }>(
  codec: WireCodec<Request>,
  initial: ScriptedTurn[],
): FakeModel<Request> {
  const requests: Request[] = [];
  const titleRequests: Request[] = [];
  const titleReplies: ScriptedReply[] = [];
  let script = initial;
  let next = 0;
  let gate: (() => Promise<void>) | undefined;

  function respond(
    turn: ScriptedTurn,
    request: Request,
    signal: AbortSignal | null | undefined,
  ): Response {
    if ("status" in turn) {
      return codec.refused(
        turn.status,
        "scripted refusal",
        turn.retryAfterSeconds,
      );
    }
    if ("overloadedAfter" in turn)
      return streamed(codec.overloadedAfter(turn.text));
    if ("stall" in turn) {
      return streamed(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(codec.stalledOpening(turn.text)),
            );
            signal?.addEventListener("abort", () =>
              controller.error(signal.reason),
            );
          },
        }),
      );
    }
    return streamed(codec.reply(turn, request));
  }

  const handle = async (
    request: Request,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> => {
    if (codec.isTitle(request)) {
      titleRequests.push(request);
      return streamed(codec.reply(titleReplies.shift() ?? NO_TITLE, request));
    }
    requests.push(request);
    const refusal = codec.refusal(request);
    if (refusal !== null) return codec.refused(400, refusal);
    if (gate) await gate();
    const turn = script[next++] ?? script[script.length - 1] ?? DEFAULT_TURN;
    return respond(turn, request, signal);
  };

  return {
    fetch: (_input, init) => {
      // An adapter posts its JSON as a string, which is the wire under test.
      if (typeof init?.body !== "string") {
        return Promise.reject(new Error("expected a JSON string body"));
      }
      return abortable(
        init.signal,
        handle(codec.parse(init.body), init.signal),
      );
    },
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
    sent: (call) => {
      const request = requests[call];
      return request === undefined ? [] : merged(codec.sent(request));
    },
    tools: (call) => {
      const request = requests[call];
      return request === undefined ? [] : codec.tools(request);
    },
  };
}

// The conversation one request carried, read off the wire.
export function messagesSentTo(fake: FakeModel, call = 0): SentMessage[] {
  return fake.sent(call);
}

// The tool names one request offered.
export function toolsSentTo(fake: FakeModel, call = 0): string[] {
  return fake.tools(call);
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
