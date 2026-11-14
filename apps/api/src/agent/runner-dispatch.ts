import {
  CommandUnansweredError,
  sendCommand,
  sendFleetCommand,
} from "../fleet/transport.js";
import { NoPlatformRunnerError } from "../fleet/router.js";
import { logger } from "../logger.js";
import type {
  Tool,
  ToolExecuteContext,
  ToolExecuteResult,
} from "./tools/types.js";

/* Named by what is known of the command. Never sent ran nothing; sent and
   unanswered may have run; a runner's own failure, or a target it cannot find, is its answer. */
type RunnerFailure = "never_sent" | "unanswered" | "expected_miss" | "system";

function classifyRunnerError(err: unknown): RunnerFailure {
  if (err instanceof NoPlatformRunnerError) return "never_sent";
  if (err instanceof CommandUnansweredError) return "unanswered";
  return isMissingTarget(err) ? "expected_miss" : "system";
}

// The runners' own wording, which crosses the wire as a plain message: both
// answer a target they cannot resolve with "No running <thing> found for".
function isMissingTarget(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /^No running \w+ found for /.test(message);
}

// High signal only: the tool, the concrete thing that failed, and what that
// leaves the agent able to say.
function runnerFailureMessage(
  tool: Extract<Tool, { on: "runner" }>,
  msg: string,
  failure: RunnerFailure,
): string {
  const name = tool.schema.name;
  if (failure === "expected_miss") {
    return `${name} read nothing: ${msg}. That is either a target named wrongly or one that is not running, and this call cannot tell you which. List what is there before concluding either.`;
  }
  if (failure === "never_sent") {
    return `${name} was not sent: ${msg}. Nothing ran, so try it again or work from what another tool can tell you.`;
  }
  if (failure === "unanswered") {
    // A runner cannot always kill what it started, so an unanswered write may have landed.
    return tool.effect === "write"
      ? `${name} did not answer: ${msg}. The outcome is unknown: the command may have run. Read the target's state before proposing ${name} again.`
      : `${name} did not answer: ${msg}. Nothing was read, so try it again or work from what another tool can tell you.`;
  }
  return `${name} failed: ${msg}. Check the arguments against the tool's description; if they were right this is a fault, and either way it is not a finding.`;
}

// Single dispatch + error-formatting primitive shared by the loop's read path and the
// resolver's approve path, so error format and logging never drift apart.
export async function executeRunnerTool(
  tool: Extract<Tool, { on: "runner" }>,
  input: Record<string, unknown>,
  ctx: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  const name = tool.schema.name;
  const options = { timeoutMs: ctx.toolTimeoutMs, signal: ctx.signal };
  try {
    if (tool.routeBy === "service") {
      return { content: await sendCommand(name, input, options) };
    }
    const { envelope, succeeded } = await sendFleetCommand(
      name,
      input,
      tool.platform,
      options,
    );
    // A fan-out has three answers, not two, and only none-answered is a
    // failure: the envelope names which server fell short either way.
    if (succeeded > 0) return { content: envelope };
    return { content: envelope, isError: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failure = classifyRunnerError(err);
    logger.warn({ tool: name, err, failure }, "runner tool failed");
    // Every branch read nothing, a missing target included, so each is an error
    // whatever its message goes on to say about the absence.
    return { content: runnerFailureMessage(tool, msg, failure), isError: true };
  }
}
