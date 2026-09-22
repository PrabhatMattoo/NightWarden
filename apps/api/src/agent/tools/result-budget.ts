import { MAX_TOOL_RESULT_CHARS } from "../../llm/config.js";
import type { TrimmableList } from "./types.js";

// Items share a budget under the whole-result ceiling, leaving room for the
// window, labels and notes wrapped around them.
export const ITEM_BUDGET_CHARS = Math.floor(MAX_TOOL_RESULT_CHARS * 0.8);

// Whole items dropped from trimmable lists until the serialized result fits
// within the character budget.
export function trimToBudget(
  content: Record<string, unknown>,
  trimmables: TrimmableList | TrimmableList[],
  maxChars = MAX_TOOL_RESULT_CHARS,
): Record<string, unknown> {
  const result = { ...content };
  const list = Array.isArray(trimmables) ? trimmables : [trimmables];

  for (const { field, end, omittedField } of list) {
    if (JSON.stringify(result).length <= maxChars) break;

    const rawArr = result[field];
    if (!Array.isArray(rawArr) || rawArr.length === 0) continue;

    const initialLength = rawArr.length;
    const omittedKey = omittedField ?? `${field}Omitted`;
    const initialOmitted =
      typeof result[omittedKey] === "number"
        ? (result[omittedKey] as number)
        : 0;

    let low = 0;
    let high = rawArr.length;
    let bestCount = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidateArr =
        end === "head"
          ? rawArr.slice(rawArr.length - mid)
          : rawArr.slice(0, mid);
      const omitted = initialLength - candidateArr.length;
      result[field] = candidateArr;
      if (omitted > 0 || initialOmitted > 0) {
        result[omittedKey] = initialOmitted + omitted;
      } else {
        delete result[omittedKey];
      }

      if (JSON.stringify(result).length <= maxChars) {
        bestCount = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const finalArr =
      end === "head"
        ? rawArr.slice(rawArr.length - bestCount)
        : rawArr.slice(0, bestCount);
    const omitted = initialLength - finalArr.length;
    result[field] = finalArr;
    if (omitted > 0 || initialOmitted > 0) {
      result[omittedKey] = initialOmitted + omitted;
    } else {
      delete result[omittedKey];
    }
  }

  return result;
}
