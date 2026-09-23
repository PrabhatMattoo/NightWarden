// One shape for a capped list, so no result leaves the model guessing what was cut.

export type CoverageKept = "newest" | "oldest" | "first";

export interface Coverage {
  shown: number;
  total: number;
  kept: CoverageKept;
  note: string;
}

// What one list may spend of a 30,000-character result, leaving room for notes.
export const ITEM_BUDGET_CHARS = 24_000;

const KEPT_PHRASE: Record<CoverageKept, string> = {
  newest: "the newest",
  oldest: "the oldest",
  first: "the first",
};

interface CoverageTerms {
  kept: CoverageKept;
  // The plural the list is counted in: "events", "series", "lines".
  noun: string;
  // How to read what was left out, in the tool's own inputs.
  reach: string;
}

// Absent when nothing was left out, so a whole list carries no coverage at all.
export function coverageOf({
  shown,
  total,
  kept,
  noun,
  reach,
}: CoverageTerms & { shown: number; total: number }): Coverage | undefined {
  if (shown >= total) return undefined;
  const order =
    kept === "first" ? ", in the order the source returned them" : "";
  return {
    shown,
    total,
    kept,
    note: `Shows ${KEPT_PHRASE[kept]} ${shown} of ${total} ${noun}${order}. The other ${total - shown} are not in this result, so their absence is not evidence. ${reach}`,
  };
}

/* Whole items from the kept end, until the count or the size runs out: half a
   series draws a shape that never happened. `spent` bounds a list sharing it. */
export function fitList<T>(
  items: readonly T[],
  terms: CoverageTerms & {
    // Which end of the array survives: the start, or the end.
    keep: "start" | "end";
    max?: number;
    budget?: number;
  },
): { items: T[]; coverage?: Coverage; spent: number } {
  const { keep, max = Infinity, budget = ITEM_BUDGET_CHARS, ...rest } = terms;
  const ordered = keep === "start" ? items : [...items].reverse();
  const kept: T[] = [];
  let spent = 0;
  for (const item of ordered) {
    if (kept.length >= max) break;
    const cost = JSON.stringify(item).length;
    if (spent + cost > budget) break;
    spent += cost;
    kept.push(item);
  }
  if (keep === "end") kept.reverse();
  const coverage = coverageOf({
    shown: kept.length,
    total: items.length,
    ...rest,
  });
  return { items: kept, spent, ...(coverage && { coverage }) };
}
