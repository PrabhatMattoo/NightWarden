// Every folder the suite makes sits in one run folder, so teardown leaves nothing behind.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    runFolder: string;
  }
}

const RUN_FOLDER_PREFIX = "nw-test-run-";

let runFolder = "";

// EPERM means the process exists under another user, so its run is still going.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

// A run that died skipped its teardown; one still running in another worktree keeps its folder.
function removeAbandonedRunFolders(): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(RUN_FOLDER_PREFIX)) continue;
    const pid = Number(name.slice(RUN_FOLDER_PREFIX.length).split("-")[0]);
    if (!isAlive(pid))
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

export function setup(project: TestProject): void {
  removeAbandonedRunFolders();
  runFolder = mkdtempSync(
    join(tmpdir(), `${RUN_FOLDER_PREFIX}${process.pid}-`),
  );
  project.provide("runFolder", runFolder);
}

export function teardown(): void {
  rmSync(runFolder, { recursive: true, force: true });
}
