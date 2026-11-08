import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  commitAll,
  currentBranch,
  hasUnpushedWork,
  isDirty,
  push,
  type CommitAuthor,
} from "./git.js";
import { gitDirFor, homeDirFor } from "./paths.js";
import { removeCheckout, type SandboxLog } from "./workspace.js";

const SIBLING_SUFFIXES = [homeDirFor(""), gitDirFor("")];

interface SalvageOptions {
  workspacesDir: string;
  // Rejects when no GitHub integration is bound; the affected workspace is
  // then kept on disk rather than silently discarded.
  authHeader(): Promise<string>;
  commitAuthor: CommitAuthor;
  log?: SandboxLog;
}

interface SalvageResult {
  pushed: number;
  kept: number;
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

// The checkout is a host bind mount, so unpushed work needs nothing from the
// dead process. Fails open per directory, so boot proceeds regardless.
export async function salvageWorkspaces(
  opts: SalvageOptions,
): Promise<SalvageResult> {
  const result: SalvageResult = { pushed: 0, kept: 0 };
  let entries;
  try {
    entries = await readdir(opts.workspacesDir, { withFileTypes: true });
  } catch {
    // No workspaces directory yet - nothing was ever provisioned.
    return result;
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      SIBLING_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
    ) {
      continue;
    }
    const dir = join(opts.workspacesDir, entry.name);
    try {
      if (!(await exists(gitDirFor(dir)))) {
        // A crash mid-clone leaves a non-repo folder; garbage either way.
        await removeCheckout(dir);
        continue;
      }
      if (await isDirty(dir)) {
        await commitAll(dir, "nightwarden: salvage at boot", opts.commitAuthor);
      }
      if (await hasUnpushedWork(dir)) {
        await push(dir, await currentBranch(dir), await opts.authHeader());
        result.pushed++;
        opts.log?.info({ dir: entry.name }, "salvaged orphaned workspace");
      }
      await removeCheckout(dir);
    } catch (err) {
      result.kept++;
      opts.log?.warn(
        {
          dir: entry.name,
          err: err instanceof Error ? err.message : String(err),
        },
        "workspace salvage failed, keeping the folder for manual recovery",
      );
    }
  }
  return result;
}
