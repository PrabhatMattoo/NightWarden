import { z } from "zod";
import type { ResolvedLLMConfig, NormalizedAlert } from "@nightwarden/shared";
import { createTitleProvider } from "../llm/factory.js";
import { updateSessionTitle } from "./store.js";
import { publishSessionTitleUpdated } from "./stream.js";
import { TITLE_SYSTEM_PROMPT } from "../agent/prompts/title.js";
import { toolSchema } from "../agent/tools/schema.js";
import type { ChatResponse, ProviderMessage } from "../llm/types.js";
import { logger } from "../logger.js";

const MAX_TITLE_WORDS = 4;
// A batched incident can carry many alerts; bound what reaches the prompt.
const MAX_ALERTS_IN_SOURCE = 10;

// Labels rather than a resolved key: the title model gets more to work with from
// what the alert actually said than from a key assembled after the fact.
export function buildAlertTitleSource(alerts: NormalizedAlert[]): string {
  return alerts
    .slice(0, MAX_ALERTS_IN_SOURCE)
    .map((a) => {
      const labels = Object.entries(a.labels)
        .filter(([key]) => key !== "alertname" && key !== "severity")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      // The label's own word, not the normalized rank: a severity we cannot
      // rank is still what the user called it, and the title reads it.
      const severity = a.labels["severity"];
      const severityPart = severity === undefined ? "" : ` (${severity})`;
      return `[${a.alertType}] ${labels}${severityPart}`.replace(/\s+/g, " ");
    })
    .join("\n");
}

/* The one tool the title provider is offered. A title in a field cannot carry
   the preamble a model writes before it, which is what "Here's a thinking
   process" was: the first four words of a reply that had not started yet. */
const SET_TITLE = toolSchema(
  "SetTitle",
  `Set the session's title. Call SetTitle once, with the title as its only argument, and write nothing else.`,
  z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .meta({
        description: `The title, at most ${MAX_TITLE_WORDS} words in Title Case, naming the concrete subject where the content has one.`,
      }),
  }),
);

// The title the model filed, or null where it answered some other way.
function titleFrom(response: ChatResponse): string | null {
  const call = response.toolUses.find((use) => use.name === "SetTitle");
  const filed = call?.input["title"];
  /* A model that would not call the tool still says something usable often
     enough to read, so the text it wrote is the second place to look. */
  const raw = typeof filed === "string" ? filed : response.text;
  return refine(raw) || null;
}

function refine(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`,;:.\s]+$/, "");
  return (
    cleaned
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, MAX_TITLE_WORDS)
      .join(" ")
      // The word slice can expose punctuation that was mid-string before it.
      .replace(/["'`,;:.\s]+$/, "")
  );
}

// Fire-and-forget on its own provider, so it cannot block or corrupt the
// investigation's stream. A failure leaves the temporary title in place.
export async function generateSessionTitle(
  sessionId: string,
  source: string,
  config: ResolvedLLMConfig,
  apiKey?: string,
): Promise<void> {
  try {
    const trimmed = source.trim();
    if (!trimmed) return;
    // A 4-word label needs the cheapest rung, and 1024 is the seatbelt:
    // reasoning shares the output budget, and a starved budget returns nothing.
    const titleConfig: ResolvedLLMConfig = {
      ...config,
      maxOutputTokens: 1024,
    };
    const provider = createTitleProvider(
      TITLE_SYSTEM_PROMPT,
      titleConfig,
      apiKey,
      { minimalReasoning: true },
    );
    // Framed as quoted material inside an instruction: a bare conversational
    // message in the user slot pulls the model into answering it instead.
    const text = `Title this session. Its opening content:\n<content>\n${trimmed}\n</content>`;
    const ask: ProviderMessage[] = [
      { role: "user", content: text, parts: [{ type: "text", text }] },
    ];
    // No retry callback: a title retry is logged by the provider and never
    // reaches the investigation's stream.
    const response = await provider.chat(ask, [SET_TITLE]);
    const title = titleFrom(response);
    if (title === null) {
      logger.warn(
        { sessionId, model: config.model, stopReason: response.stopReason },
        "session title unusable, keeping the temporary title",
      );
      return;
    }
    await updateSessionTitle(sessionId, title);
    publishSessionTitleUpdated(sessionId, title);
  } catch (err) {
    logger.warn({ err, sessionId }, "session title generation failed");
  }
}
