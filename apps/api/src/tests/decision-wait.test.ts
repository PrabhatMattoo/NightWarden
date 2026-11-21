import { describe, expect, it } from "vitest";
import { decisionWaitMessage } from "../agent/prompts/decision-wait.js";

// The span never claims longer than the wait lasted.
describe("the note on a decision that waited", () => {
  it("names the wait in whole minutes and the results read before it", () => {
    const long = decisionWaitMessage(
      "DockerExec",
      (2 * 60 + 5) * 60_000 + 59_000,
      ["e1", "e2", "e3"],
    );
    expect(long).toContain("waited 2 hours and 5 minutes");
    expect(long).toContain("Results e1, e2 and e3 were read before");

    const short = decisionWaitMessage("DockerExec", 60_000, ["e1"]);
    expect(short).toContain("waited 1 minute for");
    expect(short).toContain("Result e1 was read before");
  });
});
