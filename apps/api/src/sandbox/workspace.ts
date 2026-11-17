import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  apiRunsAsRoot,
  createSandboxContainer,
  destroyContainer,
  execInContainer,
  type SandboxLimits,
  type SandboxNetworkAttachment,
} from "./docker.js";
import {
  cloneAndCheckout,
  commitAll,
  currentBranch,
  hasUnpushedWork,
  isDirty,
  push,
  type CommitAuthor,
} from "./git.js";
import {
  installRepository,
  resolveInstallPlans,
  type InstallPlan,
  type RunStep,
} from "./install.js";
import { ensureProxy, proxyEnv } from "./proxy.js";
import { capOutput } from "./output.js";
import { gitDirFor, homeDirFor } from "./paths.js";

// Structural subset of pino so the host injects its logger instead of the
// module importing one - a hard requirement of the package-shaped boundary.
export interface SandboxLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

// Provisioning progress for the frontend: creation is slow enough to look like
// a hang on the first repo tool without it.
type SandboxStage = "cloning" | "starting" | "installing" | "ready" | "failed";

interface PullRequestRef {
  number: number;
  url: string;
  draft: boolean;
}

export interface WorkspaceOptions {
  cloneUrl: string;
  branch: string;
  // Fetched per operation, never cached: the stored token may rotate while a
  // workspace is alive.
  authHeader(): Promise<string>;
  limits: SandboxLimits;
  idleTimeoutMs: number;
  // Host dir the checkout is bind-mounted from; must be absolute since the
  // sandbox never guesses a path and Docker rejects a relative bind source.
  workspacesDir: string;
  // Host dir every sandbox mounts for mise's runtimes, so a download is paid once.
  miseDir: string;
  // "allowlist" routes egress through the shared enforcing proxy; "none" gives
  // no network from birth; "open" keeps the default bridge.
  network: "allowlist" | "open" | "none";
  // Hosts the proxy may reach, and where its generated config lives.
  allowlistHosts: string[];
  proxyConfigDir: string;
  commitAuthor: CommitAuthor;
  pullRequests: {
    create(req: {
      title: string;
      body: string;
      draft: boolean;
    }): Promise<PullRequestRef>;
    findOpenByBranch(branch: string): Promise<PullRequestRef | null>;
    update(
      prNumber: number,
      patch: { title: string; body: string },
    ): Promise<void>;
  };
  // Supplied by the host, which has the transcript: the seen set unlocks an
  // edit, and the pending set names a read still waiting for its result.
  readState?(): Promise<{ seen: string[]; pending: string[] }>;
  onStatus?(stage: SandboxStage): void;
  log?: SandboxLog;
}

export interface ExecOutcome {
  exitCode: number;
  output: string;
  truncated: boolean;
}

export interface Workspace {
  readonly sessionId: string;
  readonly dir: string;
  readonly branch: string;
  // Backs the read-before-edit guard, read from the transcript per call: seen
  // paths unlock an edit, pending ones name a read still awaiting its result.
  readState(): Promise<{ seen: Set<string>; pending: Set<string> }>;
  readonly options: WorkspaceOptions;
  exec(
    command: string,
    opts: { cwd?: string; timeoutMs: number },
  ): Promise<ExecOutcome>;
}

interface Entry {
  workspace: Workspace;
  containerId: string;
  idleTimer: NodeJS.Timeout | null;
  busy: number;
  options: WorkspaceOptions;
  // What provisioning did, held until the run's next tool boundary takes it.
  note: string | null;
}

// Private by design: tools receive ctx.sessionId and ask for their workspace
// here, since the run process exits on every gated suspend.
const sessions = new Map<string, Entry>();
const creating = new Map<string, Promise<Entry>>();

// One-shot: the root-API recommendation is a deployment fact, not a per-session
// event, so it is logged once per process rather than on every sandbox.
let warnedRootApi = false;

export async function removeCheckout(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await rm(gitDirFor(dir), { recursive: true, force: true });
  await rm(homeDirFor(dir), { recursive: true, force: true });
}

// In allowlist mode the shared proxy (with current config) must exist before
// the container attaches to its network; other modes need no preparation.
async function networkAttachment(
  options: WorkspaceOptions,
): Promise<SandboxNetworkAttachment> {
  if (options.network !== "allowlist") return { mode: options.network };
  const proxy = await ensureProxy({
    hosts: options.allowlistHosts,
    configDir: options.proxyConfigDir,
  });
  return {
    mode: "allowlist",
    networkName: proxy.networkName,
    proxyEnv: proxyEnv(proxy.proxyUrl),
  };
}

// Everything the install did becomes a note for the model, so a failure never
// leaves a dead sandbox.
async function prepareRepository(
  sandbox: { containerId: string; dir: string; homeDir: string },
  network: SandboxNetworkAttachment,
  plans: InstallPlan[],
  sessionId: string,
  options: WorkspaceOptions,
): Promise<string> {
  if (options.network === "none") {
    return 'The sandbox has no network access (the "none" setting), so mise and the dependency install did not run. Only what the sandbox image holds is available.';
  }
  options.onStatus?.("installing");
  const installer = await createSandboxContainer({
    sessionId,
    workspaceDir: sandbox.dir,
    homeDir: sandbox.homeDir,
    miseDir: options.miseDir,
    limits: options.limits,
    network,
    installsRuntimes: true,
  }).then(
    (id) => ({ id }),
    (err: unknown) => ({ err }),
  );
  const run =
    (containerId: string): RunStep =>
    async (command, timeoutMs) =>
      await execInContainer(containerId, command, { timeoutMs });
  let note: string;
  try {
    note = await installRepository(
      "id" in installer
        ? run(installer.id)
        : () => Promise.reject(installer.err),
      run(sandbox.containerId),
      plans,
    );
  } finally {
    if ("id" in installer) await destroyContainer(installer.id);
  }
  options.log?.info(
    { sessionId, lockfiles: plans.map((plan) => plan.lockfile) },
    "sandbox repository prepared",
  );
  return note;
}

// Best-effort by nature: no repo here at all is the ordinary case, and every
// failure means the folder was already beyond saving.
async function pushLeftovers(
  dir: string,
  options: WorkspaceOptions,
): Promise<void> {
  try {
    if (await isDirty(dir)) {
      await commitAll(
        dir,
        "nightwarden: checkpoint before reprovisioning",
        options.commitAuthor,
      );
    }
    if (await hasUnpushedWork(dir)) {
      await push(dir, await currentBranch(dir), await options.authHeader());
    }
  } catch {
    // Nothing to say: a fresh session has no folder, and a folder that cannot
    // be pushed is one boot salvage already declined to rescue.
  }
}

async function createEntry(
  sessionId: string,
  options: WorkspaceOptions,
): Promise<Entry> {
  try {
    return await provisionEntry(sessionId, options);
  } catch (err) {
    options.onStatus?.("failed");
    throw err;
  }
}

async function provisionEntry(
  sessionId: string,
  options: WorkspaceOptions,
): Promise<Entry> {
  const dir = join(options.workspacesDir, sessionId);
  const homeDir = homeDirFor(dir);
  // The branch is the durable state, so a fresh clone is correct once what is
  // here has reached it: a push that failed left the only copy.
  await pushLeftovers(dir, options);
  await removeCheckout(dir);
  await mkdir(dir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(options.miseDir, { recursive: true });
  options.onStatus?.("cloning");
  const authHeader = await options.authHeader();
  await cloneAndCheckout({
    url: options.cloneUrl,
    branch: options.branch,
    dir,
    authHeader,
  });
  const plans = await resolveInstallPlans(dir);
  // Local-only ignore, so a checkpoint commit never sweeps in what the installs
  // write; node_modules is never committed, whoever installs it.
  const installed = new Set([
    "node_modules/",
    ...plans.flatMap((p) => p.writes),
  ]);
  await appendFile(
    join(gitDirFor(dir), "info", "exclude"),
    `${[...installed].join("\n")}\n`,
  );
  if (apiRunsAsRoot() && !warnedRootApi) {
    warnedRootApi = true;
    options.log?.warn(
      { sessionId },
      "API runs as root, so sandbox containers run as root too; run the API as a non-root user for full sandbox hardening",
    );
  }
  options.onStatus?.("starting");
  const network = await networkAttachment(options);
  const containerId = await createSandboxContainer({
    sessionId,
    workspaceDir: dir,
    homeDir,
    miseDir: options.miseDir,
    limits: options.limits,
    network,
  });

  const note = await prepareRepository(
    { containerId, dir, homeDir },
    network,
    plans,
    sessionId,
    options,
  );

  const workspace: Workspace = {
    sessionId,
    dir,
    branch: options.branch,
    async readState() {
      const state = (await options.readState?.()) ?? { seen: [], pending: [] };
      return { seen: new Set(state.seen), pending: new Set(state.pending) };
    },
    options,
    async exec(command, opts) {
      const result = await execInContainer(containerId, command, opts);
      const capped = capOutput(result.output);
      return {
        exitCode: result.exitCode,
        output: capped.text,
        truncated: capped.truncated,
      };
    },
  };
  const entry: Entry = {
    workspace,
    containerId,
    idleTimer: null,
    busy: 0,
    options,
    note,
  };
  sessions.set(sessionId, entry);
  options.onStatus?.("ready");
  options.log?.info({ sessionId, branch: options.branch }, "sandbox created");
  return entry;
}

// Take-once, read by the loop at a tool boundary: the sandbox comes up inside a
// tool call, after the turn's prompt was sent, so the model hears of it here.
export function takeSandboxNote(sessionId: string): string | null {
  const entry = sessions.get(sessionId);
  if (entry === undefined || entry.note === null) return null;
  const { note } = entry;
  entry.note = null;
  return `## Sandbox ready\n\nThe repository is cloned into /workspace.\n\n${note}\n\nWhere a step above failed or did not run, install what the build needs yourself before you build or test.`;
}

function armIdleTimer(sessionId: string, entry: Entry): void {
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
  const timer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.busy > 0) {
      armIdleTimer(sessionId, entry);
      return;
    }
    void teardown(sessionId, "idle").catch((err: unknown) => {
      entry.options.log?.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        "sandbox idle teardown failed",
      );
    });
  }, entry.options.idleTimeoutMs);
  timer.unref();
  entry.idleTimer = timer;
}

// Single-flight acquire: idle timer is disarmed while any call is in flight,
// so teardown can never race live work.
export async function withWorkspace<T>(
  sessionId: string,
  options: WorkspaceOptions,
  fn: (ws: Workspace) => Promise<T>,
): Promise<T> {
  let entry = sessions.get(sessionId);
  if (!entry) {
    let pending = creating.get(sessionId);
    if (!pending) {
      pending = createEntry(sessionId, options).finally(() => {
        creating.delete(sessionId);
      });
      creating.set(sessionId, pending);
    }
    entry = await pending;
  }
  entry.busy++;
  if (entry.idleTimer !== null) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  try {
    return await fn(entry.workspace);
  } finally {
    entry.busy--;
    if (entry.busy === 0 && sessions.get(sessionId) === entry) {
      armIdleTimer(sessionId, entry);
    }
  }
}

// Why the sandbox is going. Only the idle sweep defers to work in flight; the
// others mean the session is going whether that work finishes or not.
export type TeardownReason = "idle" | "deleted" | "disconnected";

// Never drop a checkout without trying to push it, and if the push fails keep
// the checkout anyway: the container is cheap to recreate, the work is not.
export async function teardown(
  sessionId: string,
  reason: TeardownReason,
): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (entry.busy > 0 && reason === "idle") {
    armIdleTimer(sessionId, entry);
    return;
  }
  const { workspace, options } = entry;
  let saved = true;
  // A delete takes the work with it. Committing to someone's repository for a
  // session they asked to remove is a side effect they did not ask for.
  if (reason !== "deleted") {
    try {
      if (await isDirty(workspace.dir)) {
        await commitAll(
          workspace.dir,
          `nightwarden: checkpoint at sandbox teardown (${reason})`,
          options.commitAuthor,
        );
      }
      if (await hasUnpushedWork(workspace.dir)) {
        await push(workspace.dir, workspace.branch, await options.authHeader());
      }
    } catch (err) {
      saved = false;
      options.log?.warn(
        {
          sessionId,
          reason,
          err: err instanceof Error ? err.message : String(err),
        },
        "sandbox teardown: work could not be pushed, keeping the checkout for boot salvage",
      );
    }
  }
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
  sessions.delete(sessionId);
  await destroyContainer(entry.containerId).catch(() => undefined);
  if (saved) await removeCheckout(workspace.dir);
  options.log?.info({ sessionId, reason, saved }, "sandbox torn down");
}

export async function teardownAll(reason: TeardownReason): Promise<void> {
  await Promise.all(
    [...sessions.keys()].map(async (id) => await teardown(id, reason)),
  );
}

/* Nothing is dropped, so nothing needs pushing here: containers cannot outlive
   the process, and the git work belongs to the next boot's salvage. */
export async function releaseContainers(): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.all(
    entries.map((entry) => {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      return destroyContainer(entry.containerId).catch(() => undefined);
    }),
  );
}
