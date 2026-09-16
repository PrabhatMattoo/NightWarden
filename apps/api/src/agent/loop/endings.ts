import type { StopReason } from "../../llm/types.js";

/* Why a turn carries no usable answer, said in the transcript rather than only
   the log. Null where the turn is usable and the loop reads what it holds. */
export function turnEnding(
  reason: StopReason,
  maxOutputTokens: number,
): string | null {
  switch (reason) {
    case "done":
    case "tools":
      return null;
    case "length":
      return `The model's reply was cut off at this model's output limit of ${maxOutputTokens} tokens, so this turn is incomplete. Send a message to continue, or pick a model with a larger limit in Settings.`;
    case "filtered":
      return "The model declined to continue this investigation. Nothing further was read, and anything already recorded stands.";
    case "paused":
      return "The provider paused this turn part way through its own work and it was not resumed, so nothing was added. Send a message to continue.";
    case "error":
    case "unknown":
      return "The model provider ended this turn without an answer and without saying why, so nothing was added. Send a message to continue.";
  }
}

// The same question for the report turn, which has its own deliverable to name.
export function reportEnding(
  reason: StopReason,
  maxOutputTokens: number,
): string | null {
  switch (reason) {
    case "done":
    case "tools":
      return null;
    case "length":
      return `The report was cut off at this model's output limit of ${maxOutputTokens} tokens, so it was never finished. Raise the limit or pick a model with a larger one under Settings, Provider, then try again.`;
    case "filtered":
      return "The model declined to write the report.";
    case "paused":
      return "The provider paused the report turn part way through, so the write-up was never finished. Try again.";
    case "error":
    case "unknown":
      return "The model provider ended the report turn without an answer and without saying why.";
  }
}

/* Said on screen rather than only in the log: an investigation with no write-up
   looked exactly like one whose model chose not to write much. */
export const REPORT_GIVEN_UP =
  "The report was not written after several attempts. Your findings below are complete.";
