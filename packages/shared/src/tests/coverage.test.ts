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

  it("stops at the size budget before the count, never splitting an item", () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(10));
    const { items: kept, spent } = fitList(items, {
      ...terms,
      keep: "start",
      budget: 40,
    });
    expect(kept).toEqual(["0000000000", "1111111111", "2222222222"]);
    expect(spent).toBeLessThanOrEqual(40);
  });

  it("carries no coverage when nothing was left out", () => {
    const { items, coverage } = fitList(["a"], { ...terms, keep: "start" });
    expect(items).toEqual(["a"]);
    expect(coverage).toBeUndefined();
  });
});
