import { describe, expect, it } from "vitest";
import { fitList } from "../tools/coverage.js";

const terms = {
  kept: "newest" as const,
  noun: "lines",
  reach: "Narrow the call.",
};

describe("fitList", () => {
  it("keeps whole items from the end it was told to keep", () => {
    const items = ["a", "b", "c", "d"];
    const { items: kept, coverage } = fitList(items, {
      ...terms,
      keep: "end",
      max: 2,
    });
    expect(kept).toEqual(["c", "d"]);
    expect(coverage).toMatchObject({ shown: 2, total: 4, kept: "newest" });
    expect(coverage?.note).toBe(
      "Shows the newest 2 of 4 lines. The other 2 are not in this result, so their absence is not evidence. Narrow the call.",
    );
  });

  // Each item costs 12 characters as JSON: ten digits and two quotes.
  it("keeps an item that lands exactly on the size budget, and drops one a character over", () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(10));
    const fit = (budget: number) =>
      fitList(items, { ...terms, keep: "start", budget });
    expect(fit(36).items).toEqual(["0000000000", "1111111111", "2222222222"]);
    expect(fit(36).spent).toBe(36);
    expect(fit(35).items).toEqual(["0000000000", "1111111111"]);
  });

  it("carries no coverage when the list holds exactly the count it may show", () => {
    const { items, coverage } = fitList(["a", "b"], {
      ...terms,
      keep: "start",
      max: 2,
    });
    expect(items).toEqual(["a", "b"]);
    expect(coverage).toBeUndefined();
  });
});
