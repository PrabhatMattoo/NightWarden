import { executeRunnerTool } from "../runner-dispatch.js";
import { parseInput } from "./schema.js";
import { storeToolResult } from "../../session/tool-result-store.js";
import { stripSystemReminder } from "../system-reminder.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_RESULT_CHARS,
} from "../../llm/config.js";
import { DOCKER_TOOLS } from "./docker.js";
import { ELICITATIONS, type Elicitation } from "./elicitations.js";
import { GITHUB_TOOLS } from "./github.js";
import { HOST_TOOLS } from "./host.js";
import { K8S_TOOLS } from "./kubernetes.js";
import { LOKI_TOOLS } from "./loki.js";
import { METRICS_TOOLS } from "./metrics.js";
import { REPO_TOOLS } from "./repo.js";
import { REPORT_TOOLS } from "./report.js";
import { SENTRY_TOOLS } from "./sentry.js";
import { keptForPaging, pageOf, STORED_RESULT_TOOLS } from "./stored-result.js";
import type {
  DispatchedToolResult,
  Tool,
  ToolDispatchContext,
  ToolExecuteContext,
  ToolPolicy,
} from "./types.js";
import type { ToolResult, ToolSchema, ToolUse } from "../../llm/types.js";
import type { Platform } from "@nightwarden/shared";

// A runner tool's schema.name IS the wire command, addressed by its declared
// route; an api tool's execute IS its implementation - no mapping table.
export const TOOL_REGISTRY: Tool[] = [
  ...DOCKER_TOOLS,
  ...HOST_TOOLS,
  ...K8S_TOOLS,
  ...REPO_TOOLS,
  ...GITHUB_TOOLS,
  ...METRICS_TOOLS,
  ...LOKI_TOOLS,
  ...SENTRY_TOOLS,
  ...REPORT_TOOLS,
  ...STORED_RESULT_TOOLS,
];

// Refused whole rather than shortened: a sliced JSON result parses as a smaller
// truth, which is how an agent reports no errors in logs it never saw.
function tooLarge(name: string, chars: number): string {
  return `${name} produced ${chars} characters. A single result may be at most ${MAX_TOOL_RESULT_CHARS}, so none of this one was read. Narrow the call - a tighter filter, a shorter window, a smaller limit - and run it again.`;
}

// Stop ends a call whatever its client says, so this states only what is known.
function stoppedWhileRunning(tool: Tool): string {
  const name = tool.schema.name;
  return tool.effect === "write"
    ? `${name} was stopped while it ran, so whether it took effect is unknown. Read the target's state before calling ${name} again.`
    : `${name} was stopped before it answered, so nothing was read. Call it again if you still need it.`;
}

// Every call needs an answer, even one the stop reached before it started.
export function notRunResult(use: ToolUse): ToolResult {
  return {
    toolCallId: use.toolCallId,
    content: `${use.name} did not run, because the run was stopped first. Nothing was read or changed; call it again if you still need it.`,
    isError: true,
  };
}

// Stripped here rather than per tool: a log line or a file is the outside
// world speaking, and this is the one door all of it comes through.
function rendered(content: unknown, indent?: number): string {
  return stripSystemReminder(
    typeof content === "string"
      ? content
      : JSON.stringify(content, null, indent),
  );
}

// The caller supplies a ceiling, and a tool's own limit can only narrow it,
// never raise it past what the user allowed.
export async function executeTool(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<DispatchedToolResult> {
  const { toolCallCeilingMs, stop, ...identity } = ctx;
  const toolTimeoutMs = Math.min(
    tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    toolCallCeilingMs,
  );
  const timeout = AbortSignal.timeout(toolTimeoutMs);
  const effectiveCtx: ToolExecuteContext = {
    ...identity,
    toolTimeoutMs,
    signal: stop === undefined ? timeout : AbortSignal.any([timeout, stop]),
  };
  /* Parsed once here rather than in each handler, so a tool declares its shape
     and receives it: the arguments reaching a runner are checked too. */
  const parsed = parseInput(tool.input, input);
  if (!parsed.ok) return { content: parsed.failure.content, isError: true };
  const result =
    tool.on === "api"
      ? await tool.execute(parsed.data, effectiveCtx)
      : await executeRunnerTool(tool, parsed.data, effectiveCtx);
  if (result.isError === true && stop?.aborted === true) {
    return { content: stoppedWhileRunning(tool), isError: true };
  }

  const content = rendered(result.content);
  if (content.length <= MAX_TOOL_RESULT_CHARS) {
    return {
      content,
      ...(result.isError === true && { isError: true as const }),
      ...(result.refusal !== undefined && { refusal: result.refusal }),
    };
  }
  // Only evidence is worth paging: anything else past the ceiling is refused.
  if (result.isError === true || !tool.citable) {
    return {
      content: tooLarge(tool.schema.name, content.length),
      isError: true,
    };
  }
  // Indented so each item starts its own line and a page can end between them.
  const stored = keptForPaging(rendered(result.content, 2));
  await storeToolResult(identity.sessionId, identity.toolCallId, stored);
  return {
    content: pageOf(
      stored,
      1,
      (next) =>
        `Read on with ReadToolResult, passing this result's Evidence ID and page ${next}`,
    ),
  };
}

// The single resolver used by both the loop and human-input (resuming a stored
// interrupt). A name is stable, so it resolves by that alone.
export function findTool(toolName: string): Tool | undefined {
  return TOOL_REGISTRY.find((t) => t.schema.name === toolName);
}

// A function, because a user rule will answer from the arguments as well as
// the tool.
export function resolvePolicy(
  tool: Tool,
  _input: Record<string, unknown>,
): ToolPolicy {
  return tool.policy;
}

// Each defaults to true, so a caller that only cares about platforms still
// gets every library. The loop passes live state, so a disconnect strips tools.
interface IntegrationConnections {
  github?: boolean;
  metrics?: boolean;
  loki?: boolean;
  sentry?: boolean;
}

// What one turn offers: the things that execute, and the one thing only a
// person can answer. Assembled together so hiding and gating stay one op.
export interface OfferedToolset {
  tools: Tool[];
  elicitations: Elicitation[];
}

// One source for both the offered schemas and the names the loop resolves, so
// hiding a tool and gating it are one operation.
export function effectiveToolset(
  platforms: Set<Platform> | undefined,
  connections: IntegrationConnections = {},
  investigation = true,
): OfferedToolset {
  const {
    github = true,
    metrics = true,
    loki = true,
    sentry = true,
  } = connections;
  const has = (platform: Platform): boolean =>
    platforms === undefined || platforms.has(platform);
  return {
    tools: [
      // Host tools ride with Docker: they gate on the platform, since host facts
      // only mean something on a runner that is 1:1 with its machine.
      ...(has("docker") ? [...DOCKER_TOOLS, ...HOST_TOOLS] : []),
      ...(has("kubernetes") ? K8S_TOOLS : []),
      ...(github ? [...REPO_TOOLS, ...GITHUB_TOOLS] : []),
      ...(metrics ? METRICS_TOOLS : []),
      ...(loki ? LOKI_TOOLS : []),
      ...(sentry ? SENTRY_TOOLS : []),
      // The record is the investigation's, so a chat is offered no way to write
      // one. What a session is was decided before the run started.
      ...(investigation ? REPORT_TOOLS : []),
      // Needs nothing connected: it reads back what another tool already returned.
      ...STORED_RESULT_TOOLS,
    ],
    // Never stripped: a question needs no integration and no runner to reach a
    // human, so every session can ask one.
    elicitations: ELICITATIONS,
  };
}

// The wire shape of everything on offer, in the order the model is shown it.
export function offeredSchemas(offered: OfferedToolset): ToolSchema[] {
  return [
    ...offered.tools.map((t) => t.schema),
    ...offered.elicitations.map((e) => e.schema),
  ];
}

// Schemas only, for callers that just need the wire shape (e.g. tests); the loop uses
// effectiveToolset directly.
export function getToolSchemas(
  platforms?: Set<Platform>,
  connections?: IntegrationConnections,
): ToolSchema[] {
  return offeredSchemas(effectiveToolset(platforms, connections ?? {}));
}
