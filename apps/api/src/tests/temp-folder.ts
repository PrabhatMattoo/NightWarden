import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inject, onTestFinished } from "vitest";
import { getCurrentTest } from "vitest/suite";

// Made inside a test it goes when the test ends; made in a hook it goes with the run folder.
export function createTempFolder(): string {
  const folder = mkdtempSync(join(inject("runFolder"), "folder-"));
  if (getCurrentTest() !== undefined) {
    onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
  }
  return folder;
}
