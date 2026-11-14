import type { DispatchOptions } from "../fleet/transport.js";

// A bound as executeTool builds one: the deadline sent to the runner and the signal that enforces it.
export function within(timeoutMs = 15_000): DispatchOptions {
  return { timeoutMs, signal: AbortSignal.timeout(timeoutMs) };
}
