import { z } from "zod";
import {
  MAX_STORED_RESULT_CHARS,
  MAX_TOOL_RESULT_CHARS,
} from "../../llm/config.js";
import { readToolResult } from "../../session/tool-result-store.js";
import { getTranscriptRows } from "../../session/transcript-store.js";
import { apiTool } from "./schema.js";
import type { Tool } from "./types.js";

// Room kept on every page for the sentence saying where the rest is.
const PAGE_CHARS = MAX_TOOL_RESULT_CHARS - 1_000;

// Cut at line ends, so a page never splits a line unless one line outgrows a page.
function paginate(text: string): string[] {
  const pages: string[] = [];
  let page = "";
  for (const line of text.split("\n")) {
    for (let at = 0; at < Math.max(line.length, 1); at += PAGE_CHARS) {
      const piece = line.slice(at, at + PAGE_CHARS);
      if (page.length + piece.length + 1 > PAGE_CHARS && page !== "") {
        pages.push(page);
        page = "";
      }
      page = page === "" ? piece : `${page}\n${piece}`;
    }
  }
  if (page !== "") pages.push(page);
  return pages;
}

/* A result kept for paging: clipped at the store's ceiling, saying so on its
   last line, so every later page carries the same limit the first did. */
export function keptForPaging(whole: string): string {
  return whole.length <= MAX_STORED_RESULT_CHARS
    ? whole
    : `${whole.slice(0, MAX_STORED_RESULT_CHARS)}\n[Only the first ${MAX_STORED_RESULT_CHARS} of ${whole.length} characters were kept, so nothing past this point can be read.]`;
}

/* One page and how to reach the next. `readOn` names the continuing call, since
   page one is written before the result has an evidence id to name. */
export function pageOf(
  stored: string,
  page: number,
  readOn: (next: number) => string,
): string {
  const pages = paginate(stored);
  const rest =
    page < pages.length
      ? `The rest is not shown here, so its absence is not evidence. ${readOn(page + 1)}, or narrow the call.`
      : "This is the last page.";
  return `${pages[page - 1] ?? ""}\n\n[Page ${page} of ${pages.length}. ${rest}]`;
}

const READ_TOOL_RESULT_INPUT = z.object({
  evidenceId: z.string().meta({
    description:
      'The Evidence ID of the result to read, exactly as it appears above that result, such as "e12".',
  }),
  page: z.number().int().min(1).meta({
    description:
      "Which page to read, 1 or more. Page 1 is what the original result already showed.",
  }),
});

export const STORED_RESULT_TOOLS: Tool[] = [
  apiTool({
    name: "ReadToolResult",
    description:
      "Read another page of a tool result that was too large to show whole. Such a result ends by saying how many pages it has; pass its Evidence ID and the page you want. Reading on is often slower than asking a narrower question, so prefer tightening the original call when you know what you are looking for.",
    input: READ_TOOL_RESULT_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "text",
    execute: async ({ evidenceId, page }, ctx) => {
      const rows = await getTranscriptRows(ctx.sessionId);
      const part = rows
        .flatMap((row) => row.parts)
        .find(
          (p) =>
            p.type === "tool_result" &&
            p.evidenceId === evidenceId &&
            p.isError !== true,
        );
      const toolCallId = part?.type === "tool_result" ? part.toolCallId : null;
      const stored =
        toolCallId === null
          ? undefined
          : await readToolResult(ctx.sessionId, toolCallId);
      if (stored === undefined) {
        return {
          content: `${evidenceId} was shown whole, or is not an Evidence ID in this session, so there is no further page to read.`,
          isError: true,
        };
      }
      const pages = paginate(stored).length;
      if (page > pages) {
        return {
          content: `${evidenceId} has ${pages} page${pages === 1 ? "" : "s"}, so there is no page ${page}.`,
          isError: true,
        };
      }
      return {
        content: pageOf(
          stored,
          page,
          (next) =>
            `Read on with ReadToolResult, evidenceId "${evidenceId}" and page ${next}`,
        ),
      };
    },
  }),
];
