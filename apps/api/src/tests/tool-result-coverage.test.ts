import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { MAX_TOOL_RESULT_CHARS } from "../llm/config.js";
import { appendTranscriptRows } from "../session/transcript-store.js";
import type { Tool, ToolDispatchContext } from "../agent/tools/types.js";
import { seedChatSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";

const SESSION = "coverage-session";

const ctx = (toolCallId: string): ToolDispatchContext => ({
  toolCallCeilingMs: 30_000,
  sessionId: SESSION,
  toolCallId,
});

function toolReturning(
  content: unknown,
  citable: boolean,
  isError?: true,
): Tool {
  const base = {
    schema: {
      name: "GetHostDmesg" as const,
      description: "",
      input_schema: { type: "object" as const, properties: {} },
    },
    input: z.object({}),
    effect: "read" as const,
    policy: "auto" as const,
    on: "api" as const,
    execute: () => Promise.resolve({ content, ...(isError && { isError }) }),
  };
  return citable
    ? { ...base, citable: true, renderAs: "logs" }
    : { ...base, citable: false };
}

// Shaped like a fan-out, which no per-field rule could see inside.
const fanOut = {
  byServer: ["web-01", "web-02"].map((server) => ({
    server,
    result: {
      lines: Array.from({ length: 900 }, (_, i) => ({
        timestamp: `2026-08-10T00:00:${String(i % 60).padStart(2, "0")}Z`,
        message: `${server} I/O error on sda block ${i}`,
      })),
    },
  })),
};

// The model reads an evidence id where the transcript stamped one.
async function stampEvidence(
  toolCallId: string,
  output: string,
): Promise<void> {
  await appendTranscriptRows([
    {
      sessionId: SESSION,
      seq: 1,
      kind: "user",
      content: "",
      parts: [{ type: "tool_result", toolCallId, output, evidenceId: "e1" }],
      timestamp: new Date().toISOString(),
    },
  ]);
}

describe("a tool result past the ceiling", () => {
  let cleanup: () => void;
  beforeAll(async () => {
    cleanup = await useTempDb();
    await seedChatSession(SESSION);
  });
  afterAll(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("passes a result of exactly the ceiling through untouched, and refuses one a character longer", async () => {
    const atCeiling = "x".repeat(MAX_TOOL_RESULT_CHARS);
    const passed = await executeTool(
      toolReturning(atCeiling, false),
      {},
      ctx("tu-at-ceiling"),
    );
    expect(passed).toEqual({ content: atCeiling });

    const over = await executeTool(
      toolReturning(`${atCeiling}x`, false),
      {},
      ctx("tu-over-ceiling"),
    );
    expect(over.isError).toBe(true);
  });

  it("refuses one that is not evidence, naming the size and the move", async () => {
    const result = await executeTool(
      toolReturning(fanOut, false),
      {},
      ctx("tu-refused"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("I/O error");
    expect(result.content).toContain(String(MAX_TOOL_RESULT_CHARS));
    expect(result.content).toMatch(/narrow the call/i);
  });

  it("keeps evidence whole and shows its first page, whatever its shape", async () => {
    const result = await executeTool(
      toolReturning(fanOut, true),
      {},
      ctx("tu-paged"),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(result.content).toContain("web-01 I/O error on sda block 0");
    expect(result.content).toMatch(/\[Page 1 of \d+\./);
    expect(result.content).toMatch(/absence is not evidence/);
    expect(result.content).toMatch(/ReadToolResult/);
  });

  it("reads the rest back a page at a time by evidence id", async () => {
    const first = await executeTool(
      toolReturning(fanOut, true),
      {},
      ctx("tu-read"),
    );
    await stampEvidence("tu-read", first.content);
    const pages = Number(/\[Page 1 of (\d+)\./.exec(first.content)?.[1]);
    const reader = findTool("ReadToolResult")!;

    const last = await executeTool(
      reader,
      { evidenceId: "e1", page: pages },
      ctx("tu-reader"),
    );
    expect(last.isError).toBeUndefined();
    expect(last.content).toContain("web-02 I/O error on sda block 899");
    expect(last.content).toContain("This is the last page.");

    const beyond = await executeTool(
      reader,
      { evidenceId: "e1", page: pages + 1 },
      ctx("tu-beyond"),
    );
    expect(beyond.isError).toBe(true);
  });

  it("says there is nothing to page for a result shown whole", async () => {
    const reader = findTool("ReadToolResult")!;
    const result = await executeTool(
      reader,
      { evidenceId: "e404", page: 2 },
      ctx("tu-missing"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no further page/);
  });
});
