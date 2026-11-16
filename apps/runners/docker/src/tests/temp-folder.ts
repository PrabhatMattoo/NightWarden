import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export function createTempFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "nw-runner-test-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
