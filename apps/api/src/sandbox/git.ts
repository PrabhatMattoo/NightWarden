import { execFile } from "node:child_process";
import { GitOperationError } from "./errors.js";
import { gitDirFor } from "./paths.js";

const GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_GIT_BUFFER = 16 * 1024 * 1024;

interface GitOptions {
  workTree?: string;
  authHeader?: string;
  timeoutMs?: number;
}

// The sandbox can write the workspace's .git gitfile, so git is pointed at the
// real git dir explicitly and inherits nothing else from the API's environment.
function gitEnv(workTree: string | undefined): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    GIT_TERMINAL_PROMPT: "0",
    ...(workTree !== undefined && {
      GIT_DIR: gitDirFor(workTree),
      GIT_WORK_TREE: workTree,
    }),
  };
}

function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join("[REDACTED]");
}

// Deliberately not util.promisify: the explicit callback keeps the execFile
// contract visible so a test double can honour it faithfully.
function runGit(args: string[], opts: GitOptions): Promise<string> {
  // Per-invocation -c never touches .git/config, so the credential exists
  // only in this process's argv for the duration of the call.
  const fullArgs =
    opts.authHeader === undefined
      ? args
      : ["-c", `http.extraHeader=Authorization: ${opts.authHeader}`, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      fullArgs,
      {
        ...(opts.workTree !== undefined && { cwd: opts.workTree }),
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_BUFFER,
        env: gitEnv(opts.workTree),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new GitOperationError(
              redactSecret(
                `git ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`,
                opts.authHeader,
              ),
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

interface CloneOptions {
  url: string;
  branch: string;
  dir: string;
  authHeader: string;
}

// Clone, then put the checkout on the session branch: a resumed session finds
// its branch on the remote and continues it; a fresh one creates it locally.
export async function cloneAndCheckout(opts: CloneOptions): Promise<void> {
  await runGit(
    [
      "clone",
      "--no-tags",
      `--separate-git-dir=${gitDirFor(opts.dir)}`,
      opts.url,
      opts.dir,
    ],
    { authHeader: opts.authHeader },
  );
  const remoteExists = await runGit(
    ["rev-parse", "--verify", `origin/${opts.branch}`],
    { workTree: opts.dir },
  ).then(
    () => true,
    () => false,
  );
  if (remoteExists) {
    await runGit(["checkout", "-B", opts.branch, `origin/${opts.branch}`], {
      workTree: opts.dir,
    });
  } else {
    await runGit(["checkout", "-b", opts.branch], { workTree: opts.dir });
  }
}

export async function isDirty(dir: string): Promise<boolean> {
  const status = await runGit(["status", "--porcelain"], { workTree: dir });
  return status.trim().length > 0;
}

// The checkout itself records the session branch, so boot-time salvage needs
// no database row to know where to push.
export async function currentBranch(dir: string): Promise<string> {
  const out = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    workTree: dir,
  });
  return out.trim();
}

export interface CommitAuthor {
  name: string;
  email: string;
}

// Identity rides -c flags per invocation: nothing lands in the checkout's config.
export async function commitAll(
  dir: string,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  await runGit(["add", "-A"], { workTree: dir });
  await runGit(
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-m",
      message,
    ],
    { workTree: dir },
  );
}

// Not best-effort like changedFiles below: "nothing to propose" is an answer
// given to the user, so an unresolvable base throws rather than reads as zero.
export async function commitsAgainstBase(dir: string): Promise<number> {
  const out = await runGit(["rev-list", "--count", "origin/HEAD..HEAD"], {
    workTree: dir,
  });
  const count = parseInt(out.trim(), 10);
  if (Number.isNaN(count)) {
    throw new GitOperationError(
      `Could not count commits against the base branch: git answered "${out.trim()}"`,
    );
  }
  return count;
}

// Counts checkpoint commits and commits whose earlier push failed alike; a
// session that changed nothing pushes nothing.
export async function hasUnpushedWork(dir: string): Promise<boolean> {
  const count = await runGit(
    ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
    { workTree: dir },
  );
  return parseInt(count.trim(), 10) > 0;
}

export async function push(
  dir: string,
  branch: string,
  authHeader: string,
): Promise<void> {
  await runGit(["push", "--set-upstream", "origin", branch], {
    workTree: dir,
    authHeader,
  });
}

// Relative to origin/HEAD (set by clone). Best-effort: a missing symref just
// means an empty list, never a failed PR.
export async function changedFiles(dir: string): Promise<string[]> {
  try {
    const out = await runGit(["diff", "--name-only", "origin/HEAD...HEAD"], {
      workTree: dir,
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
