import { randomUUID } from "node:crypto";
import type {
  FleetResult,
  Platform,
  RunnerCommandMessage,
  RunnerResultMessage,
} from "@nightwarden/shared";
import { logger } from "../logger.js";
import { resolveByRunner, resolveByService } from "./router.js";
import type { RunnerConnection } from "../fleet/connections.js";

// Request/reply correlation for runner commands, owned entirely by this
// module - the registry knows nothing about pending commands.
interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  // Removes the abort listener, whichever way the command settles.
  release: () => void;
  // The socket the command went out on, so its close settles the command
  // immediately instead of waiting out the full timeout.
  conn: RunnerConnection;
  commandName: string;
}

const pending = new Map<string, PendingCommand>();

type UnansweredReason = "timeout" | "disconnect" | "stop";

/* The command went out and no answer came back, so whether it ran is unknown.
   A routing error throws before sending, and a runner's own failure is its answer. */
export class CommandUnansweredError extends Error {
  constructor(
    readonly reason: UnansweredReason,
    message: string,
  ) {
    super(message);
    this.name = "CommandUnansweredError";
  }
}

export interface DispatchOptions {
  // Sent to the runner as its deadline, and named when the wait runs out.
  timeoutMs: number;
  // The only bound: it aborts at timeoutMs, or at Stop.
  signal: AbortSignal;
}

function settle(correlationId: string): PendingCommand | undefined {
  const entry = pending.get(correlationId);
  if (entry === undefined) return undefined;
  pending.delete(correlationId);
  entry.release();
  return entry;
}

export function resolveCommand(payload: RunnerResultMessage["payload"]): void {
  const entry = settle(payload.correlationId);
  if (!entry) {
    // Already timed out or never existed, so this late result has nowhere to
    // go; log rather than drop silently so a slow runner is diagnosable.
    logger.warn(
      { correlationId: payload.correlationId },
      "late or unknown runner result discarded",
    );
    return;
  }
  if (payload.success) {
    entry.resolve(payload.result);
  } else {
    entry.reject(new Error(payload.error ?? "Runner command failed"));
  }
}

// Called from the socket's close handler: a reply can never arrive on a
// closed socket, so waiting out the timeout would only stall the investigation.
export function rejectPendingForConnection(conn: RunnerConnection): void {
  for (const [correlationId, entry] of pending) {
    if (entry.conn !== conn) continue;
    settle(correlationId);
    entry.reject(
      new CommandUnansweredError(
        "disconnect",
        `the runner disconnected before answering ${entry.commandName}`,
      ),
    );
  }
}

// One runner, one command, one reply.
function dispatch(
  conn: RunnerConnection,
  commandName: string,
  commandInput: Record<string, unknown>,
  { timeoutMs, signal }: DispatchOptions,
): Promise<unknown> {
  const correlationId = randomUUID();
  const msg: RunnerCommandMessage = {
    messageId: randomUUID(),
    type: "command",
    payload: { commandName, commandInput, correlationId, timeoutMs },
  };

  return new Promise((resolve, reject) => {
    // The signal carries the tool's deadline as well as Stop; its reason says which fired.
    const onAbort = (): void => {
      if (settle(correlationId) === undefined) return;
      const reason: unknown = signal.reason;
      reject(
        reason instanceof DOMException && reason.name === "TimeoutError"
          ? new CommandUnansweredError(
              "timeout",
              `${commandName} got no answer within ${timeoutMs}ms`,
            )
          : new CommandUnansweredError(
              "stop",
              `the run was stopped before ${commandName} answered`,
            ),
      );
    };
    pending.set(correlationId, {
      resolve,
      reject,
      release: () => signal.removeEventListener("abort", onAbort),
      conn,
      commandName,
    });
    conn.send(JSON.stringify(msg));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// A service-routed command finds its one owner and returns that server's result
// unwrapped: the model asked about one service and gets one answer.
export async function sendCommand(
  commandName: string,
  commandInput: Record<string, unknown>,
  options: DispatchOptions,
): Promise<unknown> {
  // Resolved before the Promise: a routing error is a caller mistake and should
  // throw rather than settle a pending command.
  const { conn, identity } = resolveByService(commandInput);
  const { target: _target, server: _server, container, ...rest } = commandInput;
  const service =
    container !== undefined ? { ...identity, container } : identity;
  return await dispatch(conn, commandName, { ...rest, service }, options);
}

// In parallel, so a fan-out costs one timeout rather than N. Always enveloped,
// single runner included, so there is one shape to read.
export async function sendFleetCommand(
  commandName: string,
  commandInput: Record<string, unknown>,
  platform: Platform,
  options: DispatchOptions,
): Promise<{
  envelope: FleetResult<unknown>;
  // Counted rather than flagged: the caller has to tell a partial answer from a
  // clean one and from a dead fan-out, which one boolean cannot say.
  succeeded: number;
  failed: number;
}> {
  const conns = resolveByRunner(commandInput, platform);
  const { server: _server, ...payloadInput } = commandInput;

  const settled = await Promise.allSettled(
    conns.map(
      async (conn) => await dispatch(conn, commandName, payloadInput, options),
    ),
  );

  let succeeded = 0;
  const byServer = settled.map((outcome, i) => {
    const server = conns[i]!.serverName;
    if (outcome.status === "fulfilled") {
      succeeded++;
      return { server, result: outcome.value };
    }
    // One server's failure is that entry's result, not the whole call's: the
    // others still carry evidence.
    const err: unknown = outcome.reason;
    const message = err instanceof Error ? err.message : String(err);
    return { server, result: `Error: ${message}` };
  });

  return {
    envelope: { byServer },
    succeeded,
    failed: byServer.length - succeeded,
  };
}
