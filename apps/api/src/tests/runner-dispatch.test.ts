import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import type { Tool } from "../agent/tools/types.js";
import { harness, type Harness } from "./harness.js";

const TARGET = "web-01/api/api";

function tool(name: string): Tool {
  const found = findTool(name);
  if (found === undefined) throw new Error(`${name} is not registered`);
  return found;
}

describe("a runner command that goes unanswered", () => {
  let nw: Harness;

  beforeEach(async () => {
    nw = await harness({
      listen: false,
      runners: [{ name: "web-01", services: ["api"], silent: true }],
    });
  });

  afterEach(async () => {
    await nw.close();
  });

  // Docker cannot kill an exec it started, so a write past its deadline may have landed.
  it("tells the agent a write's outcome is unknown, and a read's that nothing was read", async () => {
    const ctx = { toolCallCeilingMs: 30, sessionId: "s-1", toolCallId: "t-1" };

    const write = await executeTool(
      tool("RestartDockerService"),
      { target: TARGET, reason: "OOM loop", estimatedDowntimeSeconds: 5 },
      ctx,
    );
    const read = await executeTool(
      tool("GetDockerLogs"),
      { target: TARGET },
      ctx,
    );

    expect(write.isError).toBe(true);
    expect(write.content).toContain("outcome is unknown");
    expect(read.isError).toBe(true);
    expect(read.content).toContain("Nothing was read");
  });

  it("settles a pending read the moment the run is stopped", async () => {
    const stop = new AbortController();
    const started = Date.now();
    const pending = executeTool(
      tool("GetDockerLogs"),
      { target: TARGET },
      {
        toolCallCeilingMs: 10_000,
        sessionId: "s-1",
        toolCallId: "t-2",
        stop: stop.signal,
      },
    );
    await expect.poll(() => nw.runner.commands).toHaveLength(1);
    stop.abort();

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
