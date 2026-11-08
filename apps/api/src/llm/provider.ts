import { jsonSchema, streamText, tool } from "ai";
import type {
  AssistantContent,
  FinishReason,
  ModelMessage,
  TextStreamPart,
  ToolResultPart,
  ToolSet,
} from "ai";
import type {
  LanguageModelV4,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { toolResultText } from "@nightwarden/shared";
import type {
  MessagePart,
  PartProviderOptions,
  ToolName,
} from "@nightwarden/shared";
import { logger } from "../logger.js";
import { CHUNK_TIMEOUT_MS, FIRST_CHUNK_TIMEOUT_MS } from "./config.js";
import type { RetryNotice } from "./failures.js";
import type {
  ChatResponse,
  LLMProvider,
  OnDelta,
  ProviderMessage,
  StopReason,
  ToolSchema,
  ToolUse,
} from "./types.js";

/* Marks the system prompt, the prefix every turn repeats. The request's own
   automatic breakpoint follows the tail, so the two never exceed the four allowed. */
const CACHE_BREAKPOINT: PartProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

// A summary the provider wrote in place of the turns above it, marked so it
// goes back as the block it came from rather than as ordinary prose.
const COMPACTION: PartProviderOptions = { anthropic: { type: "compaction" } };

export interface SdkProviderOptions {
  maxOutputTokens: number;
  // Spent on the request and again on a stream that fails part way.
  maxRetries: number;
  // Reasoning, caching and context management, resolved by the factory.
  providerOptions: SharedV4ProviderOptions;
  onRetry?: (notice: RetryNotice) => void;
}

function textOf(parts: readonly MessagePart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function assistantContent(parts: readonly MessagePart[]): AssistantContent {
  return parts.flatMap((part): Exclude<AssistantContent, string> => {
    switch (part.type) {
      case "text":
        return part.text ? [{ type: "text", text: part.text }] : [];
      // A block standing for turns whose summary it cannot reproduce is worse
      // than no block, which is what a row written without one holds.
      case "compaction":
        return part.text
          ? [{ type: "text", text: part.text, providerOptions: COMPACTION }]
          : [];
      case "reasoning":
        return [
          {
            type: "reasoning",
            text: part.text,
            ...(part.providerOptions && {
              providerOptions: part.providerOptions,
            }),
          },
        ];
      case "tool_call":
        return [
          {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.name,
            input: part.input,
            ...(part.providerOptions && {
              providerOptions: part.providerOptions,
            }),
          },
        ];
      default:
        return [];
    }
  });
}

// A failure goes back as the wire's own error shape, so a provider that words
// failure differently still reads this result as one.
function resultOutput(
  output: string,
  isError: boolean,
): ToolResultPart["output"] {
  return isError
    ? { type: "error-text", value: output }
    : { type: "text", value: output };
}

/* One turn can become two messages: a tool result is its own role here, and an
   injected alert rides alongside the results it arrived with. */
function userMessages(
  parts: readonly MessagePart[],
  toolNames: ReadonlyMap<string, string>,
): ModelMessage[] {
  const results = parts.filter((p) => p.type === "tool_result");
  const text = textOf(parts);
  const messages: ModelMessage[] = [];
  if (results.length > 0) {
    messages.push({
      role: "tool",
      content: results.map((part) => ({
        type: "tool-result" as const,
        toolCallId: part.toolCallId,
        toolName: toolNames.get(part.toolCallId) ?? "",
        output: resultOutput(toolResultText(part), part.isError === true),
      })),
    });
  }
  if (text) messages.push({ role: "user", content: [{ type: "text", text }] });
  return messages;
}

function modelMessages(turns: readonly ProviderMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // A result names the tool it answers, which only the call that made it says.
  const toolNames = new Map<string, string>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type === "tool_call") toolNames.set(part.toolCallId, part.name);
    }
    if (turn.role === "assistant") {
      const content = assistantContent(turn.parts);
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }
    messages.push(...userMessages(turn.parts, toolNames));
  }
  return messages;
}

// Constrains sampling to the schema and guarantees the tool name is one of
// these; each provider is sent only the keywords it documents.
function toolSet(tools: readonly ToolSchema[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.input_schema),
        strict: true,
      }),
    ]),
  );
}

/* Keyed by the SDK's own union, so a reason it adds fails the build here rather
   than reading as a turn the model finished. */
const STOP_REASONS: Readonly<Record<FinishReason, StopReason>> = {
  stop: "done",
  "tool-calls": "tools",
  length: "length",
  "content-filter": "filtered",
  error: "error",
  // The stream ended without the provider saying it was done.
  interrupted: "error",
  other: "unknown",
};

/* Reasons the SDK folds into a broader word because it has nowhere else for
   them. The raw word says which, and each means something a run must not read as done. */
const RAW_STOP_REASONS: Readonly<Record<string, StopReason>> = {
  pause_turn: "paused",
  model_context_window_exceeded: "length",
};

/* Malformed JSON reaches the SDK's tool call as the raw text; an empty input
   reaches per-tool validation, which refuses it with a correction instead. */
function toolInput(input: unknown, name: string): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input))
    return input as Record<string, unknown>;
  logger.warn({ tool: name, input }, "tool arguments were not a JSON object");
  return {};
}

// The three shapes a stream fills in over successive deltas, held open by id.
type StreamedPart = Extract<
  MessagePart,
  { type: "text" | "reasoning" | "compaction" }
>;

/* Reasoning is kept whatever it says: a signature the provider requires back
   can arrive on a block whose summary was omitted. */
function saidNothing(part: MessagePart): boolean {
  return (
    (part.type === "text" || part.type === "compaction") && part.text === ""
  );
}

function mergeOptions(
  held: PartProviderOptions | undefined,
  arriving: PartProviderOptions,
): PartProviderOptions {
  const merged: PartProviderOptions = { ...held };
  for (const [provider, values] of Object.entries(arriving)) {
    merged[provider] = { ...merged[provider], ...values };
  }
  return merged;
}

/* One attempt at a turn. Blocks arrive interleaved and each is held open by its
   id until its own end, so the parts come out in the order the model opened them. */
class Attempt {
  readonly parts: MessagePart[] = [];
  readonly toolUses: ToolUse[] = [];
  private readonly open = new Map<string, StreamedPart>();
  // Ordinal of each text/reasoning block in the order they open, stamped on
  // the part and streamed so the client keys a row the way it is saved.
  private block = 0;

  constructor(private readonly onDelta?: OnDelta) {}

  /* What the provider needs back arrives on whichever event it chose: a signature on the last
     delta, an item id on the start, details on the end. Merged, so none replaces another. */
  private keepReasoningMetadata(
    part: StreamedPart,
    metadata: PartProviderOptions | undefined,
  ): void {
    if (part.type !== "reasoning" || metadata === undefined) return;
    part.providerOptions = mergeOptions(part.providerOptions, metadata);
  }

  read(event: TextStreamPart<ToolSet>): void {
    switch (event.type) {
      case "text-start":
      case "reasoning-start": {
        const part: StreamedPart =
          event.type === "reasoning-start"
            ? { type: "reasoning", text: "" }
            : event.providerMetadata?.["anthropic"]?.["type"] === "compaction"
              ? { type: "compaction", text: "" }
              : { type: "text", text: "" };
        part.block = this.block++;
        this.open.set(event.id, part);
        this.parts.push(part);
        this.keepReasoningMetadata(part, event.providerMetadata);
        break;
      }
      case "reasoning-end": {
        const part = this.open.get(event.id);
        if (part !== undefined)
          this.keepReasoningMetadata(part, event.providerMetadata);
        break;
      }
      case "text-delta":
      case "reasoning-delta": {
        const part = this.open.get(event.id);
        if (part === undefined) break;
        part.text += event.text;
        this.keepReasoningMetadata(part, event.providerMetadata);
        // Only the visible answer streams: reasoning is replayed to the
        // model, and a compaction is drawn as its own divider.
        if (event.text && part.type === "text") {
          this.onDelta?.({ text: event.text, block: part.block ?? 0 });
        }
        break;
      }
      case "tool-call": {
        const input = toolInput(event.input, event.toolName);
        this.toolUses.push({
          toolCallId: event.toolCallId,
          name: event.toolName,
          input,
        });
        this.parts.push({
          type: "tool_call",
          toolCallId: event.toolCallId,
          name: event.toolName,
          input,
          ...(event.providerMetadata && {
            providerOptions: mergeOptions(undefined, event.providerMetadata),
          }),
        });
        break;
      }
      default:
        break;
    }
  }
}

// Configuration, never conversation: the caller owns the transcript and hands
// over the whole of it, so a retry re-sends a value rather than growing one.
export class SdkProvider implements LLMProvider {
  constructor(
    private readonly model: LanguageModelV4,
    private readonly system: string,
    private readonly opts: SdkProviderOptions,
  ) {}

  async chat(
    messages: readonly ProviderMessage[],
    tools: ToolSchema[],
    onDelta?: OnDelta,
    signal?: AbortSignal,
    forceTool?: ToolName,
  ): Promise<ChatResponse> {
    const { maxRetries, onRetry } = this.opts;
    let attempts = 0;
    let attempt = new Attempt(onDelta);
    const failures: unknown[] = [];

    const result = streamText({
      model: this.model,
      instructions: {
        role: "system",
        content: this.system,
        providerOptions: CACHE_BREAKPOINT,
      },
      messages: modelMessages(messages),
      tools: toolSet(tools),
      ...(forceTool !== undefined && {
        toolChoice: { type: "tool" as const, toolName: forceTool },
      }),
      maxOutputTokens: this.opts.maxOutputTokens,
      providerOptions: this.opts.providerOptions,
      ...(signal !== undefined && { abortSignal: signal }),
      maxRetries,
      streamRetries: maxRetries,
      timeout: {
        firstChunkMs: FIRST_CHUNK_TIMEOUT_MS,
        chunkMs: CHUNK_TIMEOUT_MS,
      },
      // Fires ahead of the parts still queued for the reader, so it only records.
      onError: ({ error }) => {
        failures.push(error);
      },
      /* Built once per attempt, after every part of the one before has passed
         through, so a retry lands between the attempts rather than inside one. */
      experimental_transform: () => {
        if (attempts++ > 0) {
          const err = failures.shift();
          logger.warn(
            { model: this.model.modelId, attempt: attempts, err },
            "LLM stream failed part way, retrying",
          );
          onRetry?.({ attempt: attempts, maxAttempts: maxRetries + 1, err });
          attempt = new Attempt(onDelta);
        }
        const current = attempt;
        return new TransformStream({
          transform(part, controller) {
            current.read(part);
            controller.enqueue(part);
          },
        });
      },
    });

    for await (const part of result.fullStream) {
      // The request failed part way; returning what arrived would read as a
      // turn the model finished.
      if (part.type === "error") throw part.error;
    }
    // A timeout or a stop ends the stream quietly and rejects these instead.
    const [finishReason, rawFinishReason, usage] = await Promise.all([
      result.finishReason,
      result.rawFinishReason,
      result.usage,
    ]);
    const stopReason =
      RAW_STOP_REASONS[rawFinishReason ?? ""] ?? STOP_REASONS[finishReason];
    logger.info(
      {
        model: this.model.modelId,
        turns: messages.length,
        // Kept for diagnosis alone: nothing branches on a provider's word.
        stopReason,
        ...(stopReason === "unknown" && {
          reported: rawFinishReason ?? finishReason,
        }),
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.inputTokenDetails.cacheReadTokens,
        cacheWrite: usage.inputTokenDetails.cacheWriteTokens,
      },
      "LLM usage",
    );

    const parts = attempt.parts.filter((p) => !saidNothing(p));
    return {
      stopReason,
      toolUses: attempt.toolUses,
      text: textOf(parts),
      parts,
    };
  }
}
