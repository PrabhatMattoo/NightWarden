import { z } from "zod";
import { describe, expect, it } from "vitest";
import { executeTool } from "../agent/tools/toolset.js";
import { trimToBudget } from "../agent/tools/result-budget.js";
import { MAX_TOOL_RESULT_CHARS } from "../llm/config.js";
import type {
  Tool,
  ToolDispatchContext,
  TrimmableList,
} from "../agent/tools/types.js";

const CTX: ToolDispatchContext = {
  toolCallCeilingMs: 30_000,
  sessionId: "budget-session",
  toolCallId: "tu-budget",
};

function toolReturning(
  content: unknown,
  trimmable?: TrimmableList | TrimmableList[],
): Tool {
  return {
    schema: {
      name: "GetDockerLogs",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    input: z.object({}),
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "text",
    on: "api",
    trimmable,
    execute: () => Promise.resolve({ content }),
  };
}

describe("the ceiling on one tool result", () => {
  it("refuses an oversized result whole when not trimmable, naming the size and the move", async () => {
    const lines = Array.from(
      { length: 4_000 },
      (_, i) => `2026-08-10T00:00:00Z connection refused to upstream ${i}`,
    );
    const result = await executeTool(toolReturning({ lines }), {}, CTX);

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("connection refused");
    expect(result.content).toContain("GetDockerLogs");
    expect(result.content).toContain(String(MAX_TOOL_RESULT_CHARS));
    expect(result.content).toMatch(/narrow the call/i);
  });

  it("trims trimmable fields from head to fit budget, stamping omitted count", async () => {
    const lines = Array.from(
      { length: 2_000 },
      (_, i) => `line ${i.toString().padStart(4, "0")}: ${"x".repeat(50)}`,
    );
    const tool = toolReturning(
      { lines, scannedLines: 2_000 },
      { field: "lines", end: "head", omittedField: "linesOmitted" },
    );

    const result = await executeTool(tool, {}, CTX);

    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);

    const parsed = JSON.parse(result.content) as {
      lines: string[];
      scannedLines: number;
      linesOmitted: number;
    };
    expect(parsed.linesOmitted).toBeGreaterThan(0);
    expect(parsed.lines.length + parsed.linesOmitted).toBe(2_000);
    // Head was dropped: kept lines are from the end of the array
    expect(parsed.lines[parsed.lines.length - 1]).toBe(lines[lines.length - 1]);
  });

  it("trims trimmable fields from tail to fit budget, stamping omitted count", async () => {
    const commits = Array.from({ length: 500 }, (_, i) => ({
      id: `commit-${i}`,
      message: `commit message ${i} ${"y".repeat(100)}`,
    }));
    const tool = toolReturning(
      { commits, version: "v1.0.0" },
      { field: "commits", end: "tail", omittedField: "commitsOmitted" },
    );

    const result = await executeTool(tool, {}, CTX);

    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);

    const parsed = JSON.parse(result.content) as {
      commits: typeof commits;
      version: string;
      commitsOmitted: number;
    };
    expect(parsed.commitsOmitted).toBeGreaterThan(0);
    expect(parsed.commits.length + parsed.commitsOmitted).toBe(500);
    // Tail was dropped: kept commits start at the beginning of the array
    expect(parsed.commits[0]).toEqual(commits[0]);
  });

  it("leaves result untouched when already under budget", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const tool = toolReturning(
      { lines },
      { field: "lines", end: "head", omittedField: "linesOmitted" },
    );

    const result = await executeTool(tool, {}, CTX);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      lines: string[];
      linesOmitted?: number;
    };
    expect(parsed.lines).toEqual(lines);
    expect(parsed.linesOmitted).toBeUndefined();
  });
});

describe("trimToBudget direct unit behavior", () => {
  it("drops whole items and handles pre-existing omitted counts correctly", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      pad: "z".repeat(100),
    }));
    const trimmed = trimToBudget(
      { items, initialField: "preserved" },
      { field: "items", end: "tail", omittedField: "itemsOmitted" },
      500,
    );

    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(500);
    const kept = trimmed["items"] as typeof items;
    const omitted = trimmed["itemsOmitted"] as number;
    expect(kept.length + omitted).toBe(20);
    expect(trimmed["initialField"]).toBe("preserved");
  });
});
