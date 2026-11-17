import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { execFileMock, MockDocker } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  MockDocker: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import {
  releaseContainers,
  takeSandboxNote,
  teardown,
  withWorkspace,
  type Workspace,
  type WorkspaceOptions,
} from "../sandbox/workspace.js";
import { salvageWorkspaces } from "../sandbox/salvage.js";
import { reapOrphans, resetIsolationCache } from "../sandbox/docker.js";
import { createTempFolder } from "./temp-folder.js";
import { waitFor } from "./wait.js";

const AUTH_HEADER = "Basic c2VjcmV0dG9rZW4=";

// Scriptable git double honouring the execFile callback contract exactly: (error, stdout,
// stderr). Clone materializes cloneFiles plus the git dir's info/, matching a real clone's disk layout.
const gitState = {
  remoteBranchExists: false,
  dirty: false,
  unpushed: "0",
  failPush: false,
  calls: [] as string[][],
  cloneFiles: {} as Record<string, string>,
};

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function installGitMock(): void {
  execFileMock.mockImplementation((...fnArgs: unknown[]) => {
    // execFile(file, args, options?, callback) - normalize the optional options.
    const args = fnArgs[1] as string[];
    const cb = fnArgs[fnArgs.length - 1] as ExecCb;
    const stripped = [...args];
    while (stripped[0] === "-c") stripped.splice(0, 2);
    const sub = stripped[0] ?? "";
    gitState.calls.push(args);
    const ok = (stdout = ""): void => cb(null, stdout, "");
    const fail = (msg: string): void => cb(new Error(msg), "", msg);
    switch (sub) {
      case "--version":
        return ok("git version 2.44.0");
      case "clone": {
        const dir = stripped[stripped.length - 1]!;
        const gitDir = stripped.find((a) =>
          a.startsWith("--separate-git-dir="),
        )!;
        mkdirSync(join(gitDir.slice("--separate-git-dir=".length), "info"), {
          recursive: true,
        });
        for (const [rel, content] of Object.entries(gitState.cloneFiles)) {
          mkdirSync(join(dir, rel, ".."), { recursive: true });
          writeFileSync(join(dir, rel), content);
        }
        return ok();
      }
      case "rev-parse":
        // --abbrev-ref HEAD asks the checkout for its own branch (salvage);
        // --verify origin/<branch> probes the remote (resume-vs-fresh clone).
        if (args.includes("--abbrev-ref")) {
          return ok("nightwarden/fix-oom-12345678\n");
        }
        return gitState.remoteBranchExists
          ? ok("abc123\n")
          : fail("fatal: Needed a single revision");
      case "checkout":
        return ok();
      case "status":
        return ok(gitState.dirty ? " M src/app.ts\n" : "");
      case "add":
        return ok();
      case "commit":
        gitState.dirty = false;
        gitState.unpushed = "1";
        return ok();
      case "rev-list":
        return ok(`${gitState.unpushed}\n`);
      case "push": {
        if (gitState.failPush) {
          const header = args
            .find((a) => a.startsWith("http.extraHeader="))
            ?.slice("http.extraHeader=".length);
          return fail(
            `fatal: unable to access repo: 403 (sent ${header ?? "no header"})`,
          );
        }
        gitState.unpushed = "0";
        return ok();
      }
      default:
        return ok();
    }
  });
}

const dockerState = {
  createArgs: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  listResult: [] as Array<{ Id: string }>,
  // exec:<command> entries in arrival order.
  events: [] as string[],
  execCmds: [] as string[][],
  // Which container, by name, ran each command, in arrival order.
  ranIn: [] as Array<{ container: string; command: string }>,
  names: {} as Record<string, string>,
  execHandler: ((_command: string) => ({ exitCode: 0, output: "ok\n" })) as (
    command: string,
  ) => { exitCode: number; output: string },
  // Image world: local builds (sandbox image + proxy image) with the labels
  // they were built with, created networks, and the shared proxy container.
  builtImages: [] as string[],
  imageLabels: {} as Record<string, Record<string, string>>,
  networksCreated: [] as Array<Record<string, unknown>>,
  sandboxNetExists: false,
  proxyInfo: null as null | {
    running: boolean;
    labels: Record<string, string>;
  },
  pingFails: false,
  createFails: false,
  gvisor: false,
  nextId: 1,
};

const PROXY_NAME = "nightwarden-sandbox-proxy";

function execEvents(): string[] {
  return dockerState.events
    .filter((e) => e.startsWith("exec:"))
    .map((e) => e.slice("exec:".length));
}

// Minimal stream honouring the contract execInContainer relies on: data
// chunks, then end. Raw (non-multiplexed) output exercises demux passthrough.
function fakeStream(output: string): {
  on: (event: string, cb: (chunk?: Buffer) => void) => void;
} {
  return {
    on(event, cb) {
      if (event === "data" && output.length > 0) cb(Buffer.from(output));
      if (event === "end") cb();
    },
  };
}

function installDockerMock(): void {
  // A function expression, not an arrow: getDocker() constructs with `new`,
  // and a constructor returning an object yields that object.
  MockDocker.mockImplementation(function () {
    return dockerFake();
  });
}

function dockerFake(): Record<string, unknown> {
  return {
    ping: () =>
      dockerState.pingFails
        ? Promise.reject(new Error("connect ENOENT /var/run/docker.sock"))
        : Promise.resolve({}),
    info: () =>
      Promise.resolve({
        Runtimes: dockerState.gvisor ? { runc: {}, runsc: {} } : { runc: {} },
      }),
    getImage: (name: string) => ({
      inspect: () =>
        dockerState.builtImages.includes(name)
          ? Promise.resolve({
              Config: { Labels: dockerState.imageLabels[name] ?? {} },
            })
          : Promise.reject(new Error("no such image")),
    }),
    buildImage: (
      _ctx: unknown,
      opts: { t: string; labels?: Record<string, string> },
    ) => {
      dockerState.builtImages.push(opts.t);
      dockerState.imageLabels[opts.t] = opts.labels ?? {};
      return Promise.resolve({});
    },
    modem: {
      followProgress: (
        _stream: unknown,
        cb: (err: Error | null, events: unknown[]) => void,
      ) => cb(null, []),
    },
    createContainer: (opts: Record<string, unknown>) => {
      if (dockerState.createFails) {
        return Promise.reject(new Error("no such runtime"));
      }
      dockerState.createArgs.push(opts);
      if (opts["name"] === PROXY_NAME) {
        const labels = opts["Labels"] as Record<string, string>;
        dockerState.proxyInfo = { running: false, labels };
        return Promise.resolve({
          id: PROXY_NAME,
          start: () => {
            if (dockerState.proxyInfo) dockerState.proxyInfo.running = true;
            return Promise.resolve();
          },
        });
      }
      const id = `container-${dockerState.nextId++}`;
      dockerState.names[id] = String(opts["name"]);
      return Promise.resolve({ id, start: () => Promise.resolve() });
    },
    getContainer: (id: string) => {
      if (id === PROXY_NAME) {
        return {
          inspect: () =>
            dockerState.proxyInfo === null
              ? Promise.reject(new Error("no such container"))
              : Promise.resolve({
                  State: { Running: dockerState.proxyInfo.running },
                  Config: { Labels: dockerState.proxyInfo.labels },
                }),
          remove: () => {
            dockerState.proxyInfo = null;
            dockerState.removed.push(id);
            return Promise.resolve();
          },
        };
      }
      return {
        remove: () => {
          dockerState.removed.push(id);
          return Promise.resolve();
        },
        exec: (opts: { Cmd: string[] }) => {
          const command = String(opts.Cmd[opts.Cmd.length - 1] ?? "");
          dockerState.events.push(`exec:${command}`);
          dockerState.execCmds.push(opts.Cmd);
          dockerState.ranIn.push({
            container: dockerState.names[id] ?? id,
            command,
          });
          const result = dockerState.execHandler(command);
          return Promise.resolve({
            start: () => Promise.resolve(fakeStream(result.output)),
            inspect: () => Promise.resolve({ ExitCode: result.exitCode }),
          });
        },
      };
    },
    listContainers: () => Promise.resolve(dockerState.listResult),
    listNetworks: () =>
      Promise.resolve(
        dockerState.sandboxNetExists
          ? [{ Name: "nightwarden-sandbox-net" }]
          : [],
      ),
    createNetwork: (opts: Record<string, unknown>) => {
      dockerState.networksCreated.push(opts);
      dockerState.sandboxNetExists = true;
      return Promise.resolve({});
    },
    getNetwork: (name: string) => ({
      inspect: () =>
        Promise.resolve({ IPAM: { Config: [{ Subnet: "172.28.0.0/16" }] } }),
      connect: (opts: { Container: string }) => {
        dockerState.events.push(`connect:${name}:${opts.Container}`);
        return Promise.resolve();
      },
    }),
  };
}

let workspacesDir: string;
let sessionCounter = 0;

function options(overrides?: Partial<WorkspaceOptions>): WorkspaceOptions {
  return {
    cloneUrl: "https://github.com/acme/api.git",
    branch: "nightwarden/fix-oom-12345678",
    authHeader: () => Promise.resolve(AUTH_HEADER),
    limits: { cpus: 2, memoryMb: 4096 },
    idleTimeoutMs: 60_000,
    workspacesDir,
    miseDir: join(workspacesDir, "mise"),
    network: "none",
    allowlistHosts: ["registry.npmjs.org"],
    proxyConfigDir: join(workspacesDir, "proxy-config"),
    commitAuthor: { name: "NightWarden", email: "noreply@nightwarden.local" },
    pullRequests: {
      create: () => Promise.resolve({ number: 1, url: "", draft: true }),
      findOpenByBranch: () => Promise.resolve(null),
      update: () => Promise.resolve(),
    },
    ...overrides,
  };
}

function nextSessionId(): string {
  sessionCounter++;
  return `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, "0")}`;
}

beforeAll(() => {
  workspacesDir = createTempFolder();
  installGitMock();
  installDockerMock();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  vi.useRealTimers();
  gitState.failPush = false;
  await releaseContainers();
  gitState.remoteBranchExists = false;
  gitState.dirty = false;
  gitState.unpushed = "0";
  gitState.calls = [];
  gitState.cloneFiles = {};
  dockerState.createArgs = [];
  dockerState.removed = [];
  dockerState.listResult = [];
  dockerState.events = [];
  dockerState.execCmds = [];
  dockerState.ranIn = [];
  dockerState.names = {};
  dockerState.execHandler = () => ({ exitCode: 0, output: "ok\n" });
  dockerState.builtImages = [];
  dockerState.imageLabels = {};
  dockerState.networksCreated = [];
  dockerState.sandboxNetExists = false;
  dockerState.proxyInfo = null;
  dockerState.pingFails = false;
  dockerState.createFails = false;
  dockerState.gvisor = false;
  resetIsolationCache();
});

function cloneCalls(): string[][] {
  return gitState.calls.filter((args) => args.includes("clone"));
}

describe("workspace lifecycle", () => {
  it("creates lazily: clone with per-invocation auth lands before the tool body runs, in a hardened container", async () => {
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), (ws) => {
      // Both the checkout and the container exist before any tool code runs.
      expect(cloneCalls()).toHaveLength(1);
      expect(dockerState.createArgs).toHaveLength(1);
      expect(ws.dir).toBe(join(workspacesDir, sessionId));
      expect(ws.branch).toBe("nightwarden/fix-oom-12345678");
      return Promise.resolve(undefined);
    });

    const clone = cloneCalls()[0]!;
    expect(clone[0]).toBe("-c");
    expect(clone[1]).toBe(`http.extraHeader=Authorization: ${AUTH_HEADER}`);
    expect(clone).toContain("https://github.com/acme/api.git");

    // The locally built image, not stock node - global tooling is baked in.
    const create = dockerState.createArgs[0]!;
    expect(create["Image"]).toBe("nightwarden-sandbox");
    expect(dockerState.builtImages).toContain("nightwarden-sandbox");
    // HOME rides its own mount so package-manager caches never land inside
    // the checkout (git add -A would sweep them into checkpoint commits).
    expect(create["Env"]).toContain("HOME=/home/sandbox");
    expect(create["Env"]).toContain("COREPACK_ENABLE_DOWNLOAD_PROMPT=0");
    // Global installs must resolve into the writable HOME, and its bin must
    // win the PATH.
    expect(create["Env"]).toContain(
      "NPM_CONFIG_PREFIX=/home/sandbox/.npm-global",
    );
    expect(
      (create["Env"] as string[]).some((e) =>
        e.startsWith("PATH=/home/sandbox/.npm-global/bin:"),
      ),
    ).toBe(true);
    expect(create["Labels"]).toMatchObject({
      "nightwarden.sandbox": "1",
      "nightwarden.session": sessionId,
    });
    const host = create["HostConfig"] as Record<string, unknown>;
    expect(host["ReadonlyRootfs"]).toBe(true);
    expect(host["CapDrop"]).toEqual(["ALL"]);
    expect(host["SecurityOpt"]).toEqual(["no-new-privileges"]);
    expect(host["NanoCpus"]).toBe(2_000_000_000);
    expect(host["Memory"]).toBe(4096 * 1024 * 1024);
    // Every sandbox reads the shared runtimes, and none can write them.
    expect(host["Binds"]).toEqual([
      `${join(workspacesDir, sessionId)}:/workspace`,
      `${join(workspacesDir, sessionId)}.home:/home/sandbox`,
      `${join(workspacesDir, "mise")}:/mise:ro`,
    ]);
    expect(create["Env"]).toContain(
      "MISE_SHARED_INSTALL_DIRS=/mise/data/installs",
    );
    // Wall reinforcements: real memory cap (swap == memory), fork-bomb and fd
    // limits, non-root ownership-matched user, no-dev tmpfs.
    expect(host["MemorySwap"]).toBe(4096 * 1024 * 1024);
    expect(host["PidsLimit"]).toBe(512);
    expect(host["Ulimits"]).toEqual([
      { Name: "nofile", Soft: 4096, Hard: 4096 },
    ]);
    expect(host["Tmpfs"]).toEqual({ "/tmp": "rw,exec,nosuid,nodev,size=1g" });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && gid !== undefined) {
      expect(create["User"]).toBe(`${uid}:${gid}`);
    }
    // Standard host advertises no runsc runtime: no Runtime override.
    expect(host["Runtime"]).toBeUndefined();
  });

  it("runs under the gVisor runtime when the host advertises runsc", async () => {
    dockerState.gvisor = true;
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    const host = dockerState.createArgs[0]!["HostConfig"] as Record<
      string,
      unknown
    >;
    expect(host["Runtime"]).toBe("runsc");
  });

  it("reuses the live workspace across calls in a burst", async () => {
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    expect(cloneCalls()).toHaveLength(1);
    expect(dockerState.createArgs).toHaveLength(1);
  });

  it("tears down after the idle timeout without pushing when nothing changed, and a resume re-clones the same branch", async () => {
    vi.useFakeTimers();
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    // The sibling HOME mount dies with the workspace, and teardown removes it
    // last - so waiting on it is what proves the whole sequence finished.
    await waitFor(() => !existsSync(join(workspacesDir, `${sessionId}.home`)));
    expect(existsSync(join(workspacesDir, sessionId))).toBe(false);
    expect(existsSync(join(workspacesDir, `${sessionId}.git`))).toBe(false);
    expect(dockerState.removed).toHaveLength(1);
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(false);

    // Resume: same branch, found on the remote now.
    gitState.remoteBranchExists = true;
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    expect(cloneCalls()).toHaveLength(2);
    const checkout = gitState.calls
      .filter((a) => a.includes("checkout"))
      .at(-1);
    expect(checkout).toEqual([
      "checkout",
      "-B",
      "nightwarden/fix-oom-12345678",
      "origin/nightwarden/fix-oom-12345678",
    ]);
  });

  it("checkpoint-commits and pushes dirty work at idle teardown", async () => {
    vi.useFakeTimers();
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), () => {
      gitState.dirty = true;
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await waitFor(() => dockerState.removed.length === 1);
    expect(gitState.calls.some((a) => a.includes("commit"))).toBe(true);
    const push = gitState.calls.find((a) => a.includes("push"));
    expect(push).toBeDefined();
    expect(push).toContain("nightwarden/fix-oom-12345678");
    expect(push?.[1]).toBe(`http.extraHeader=Authorization: ${AUTH_HEADER}`);
  });

  it("keeps the checkout when the push fails, and stops the container anyway", async () => {
    const warn = vi.fn();
    vi.useFakeTimers();
    const sessionId = nextSessionId();
    await withWorkspace(
      sessionId,
      options({
        log: { info: vi.fn(), warn },
      }),
      () => {
        gitState.dirty = true;
        gitState.failPush = true;
        return Promise.resolve();
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await waitFor(() => warn.mock.calls.length > 0);
    // The container is disposable, so it always goes. The checkout holds
    // commits that exist nowhere else, so it always stays.
    expect(dockerState.removed).toHaveLength(1);
    expect(existsSync(join(workspacesDir, sessionId))).toBe(true);
  });

  it("never lets the auth header reach a git error message", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const sessionId = nextSessionId();
    await withWorkspace(
      sessionId,
      options({ log: { info: vi.fn(), warn } }),
      () => {
        gitState.dirty = true;
        gitState.failPush = true;
        return Promise.resolve();
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    const logged = await waitFor(() => warn.mock.calls[0]);
    const fields = logged[0] as { err: string };
    expect(fields.err).toContain("[REDACTED]");
    expect(fields.err).not.toContain(AUTH_HEADER);
    expect(fields.err).toContain("git push failed");
  });

  it("reapOrphans removes every labeled container", async () => {
    dockerState.listResult = [{ Id: "orphan-1" }, { Id: "orphan-2" }];
    const reaped = await reapOrphans();
    expect(reaped).toBe(2);
    expect(dockerState.removed).toEqual(["orphan-1", "orphan-2"]);
  });
});

describe("host-side git with real git", () => {
  // Real git and its real execFile: the harm is git reading what the sandbox
  // wrote, which a double cannot reproduce.
  let realExecFileSync: typeof import("node:child_process").execFileSync;
  const gitEnv = {
    PATH: process.env["PATH"],
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]): string =>
    realExecFileSync("git", args, { env: gitEnv, encoding: "utf8" });

  beforeAll(async () => {
    const real =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    realExecFileSync = real.execFileSync;
    execFileMock.mockImplementation(real.execFile);
  });

  afterAll(() => {
    installGitMock();
  });

  it("never runs a hook or fsmonitor command the sandbox planted in the checkout", async () => {
    const root = createTempFolder();
    const seed = join(root, "seed");
    const remote = join(root, "remote.git");
    git("init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "README.md"), "seed\n");
    git("-C", seed, "add", ".");
    git(
      "-C",
      seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "seed",
    );
    git("clone", "-q", "--bare", seed, remote);

    const marker = join(root, "planted-ran");
    const payload = join(root, "payload.sh");
    writeFileSync(payload, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(payload, 0o755);

    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options({ cloneUrl: remote }), (ws) => {
      // What anything in the container can do: replace whatever .git is with
      // a repository of its own that carries a hook, a hooksPath and fsmonitor.
      rmSync(join(ws.dir, ".git"), { recursive: true, force: true });
      git("init", "-q", ws.dir);
      const hooks = join(ws.dir, ".git", "hooks");
      mkdirSync(hooks, { recursive: true });
      for (const hook of ["pre-commit", "post-commit", "pre-push"]) {
        copyFileSync(payload, join(hooks, hook));
      }
      git("-C", ws.dir, "config", "core.hooksPath", hooks);
      git("-C", ws.dir, "config", "core.fsmonitor", payload);
      writeFileSync(join(ws.dir, "fix.ts"), "export {};\n");
      return Promise.resolve();
    });
    await teardown(sessionId, "idle");

    expect(existsSync(marker)).toBe(false);
    // The checkpoint commit still reached the session branch on the remote.
    expect(
      git("--git-dir", remote, "ls-tree", "--name-only", options().branch),
    ).toContain("fix.ts");
  });
});

describe("sandbox network modes", () => {
  async function createWorkspace(
    overrides?: Partial<WorkspaceOptions>,
  ): Promise<Workspace> {
    const sessionId = nextSessionId();
    let captured: Workspace | undefined;
    await withWorkspace(sessionId, options(overrides), (ws) => {
      captured = ws;
      return Promise.resolve();
    });
    return captured!;
  }

  function sandboxCreateArgs(): Record<string, unknown> {
    const args = dockerState.createArgs.filter((a) => a["name"] !== PROXY_NAME);
    return args[args.length - 1]!;
  }

  function hostConfig(args: Record<string, unknown>): Record<string, unknown> {
    return args["HostConfig"] as Record<string, unknown>;
  }

  it("allowlist: sandbox lives on the internal proxy network with proxy env preset", async () => {
    await createWorkspace({ network: "allowlist" });

    // The internal network is the enforcement: no route out except the proxy.
    expect(
      dockerState.networksCreated.some(
        (n) =>
          n["Name"] === "nightwarden-sandbox-net" && n["Internal"] === true,
      ),
    ).toBe(true);
    const create = sandboxCreateArgs();
    expect(hostConfig(create)["NetworkMode"]).toBe("nightwarden-sandbox-net");
    const env = create["Env"] as string[];
    expect(env).toContain("HTTP_PROXY=http://nightwarden-sandbox-proxy:8888");
    expect(env).toContain("HTTPS_PROXY=http://nightwarden-sandbox-proxy:8888");
    expect(env).toContain("NO_PROXY=localhost,127.0.0.1");
    // Yarn 2 and later read only their own variables, so without these they
    // would try to reach the registry directly and fail on the internal network.
    expect(env).toContain(
      "YARN_HTTPS_PROXY=http://nightwarden-sandbox-proxy:8888",
    );

    // Proxy built locally, dual-homed onto the bridge, filter carries the hosts.
    expect(dockerState.builtImages).toContain("nightwarden-tinyproxy");
    expect(dockerState.events).toContain(`connect:bridge:${PROXY_NAME}`);
    const cfgDir = join(workspacesDir, "proxy-config");
    expect(readFileSync(join(cfgDir, "filter"), "utf8")).toContain(
      "registry.npmjs.org",
    );
    const conf = readFileSync(join(cfgDir, "tinyproxy.conf"), "utf8");
    expect(conf).toContain("FilterDefaultDeny Yes");
    expect(conf).toContain("Allow 172.28.0.0/16");
  });

  it("allowlist: a running proxy with matching config is reused; changed hosts recreate it", async () => {
    await createWorkspace({ network: "allowlist" });
    const createsAfterFirst = dockerState.createArgs.filter(
      (a) => a["name"] === PROXY_NAME,
    ).length;
    expect(createsAfterFirst).toBe(1);

    await createWorkspace({ network: "allowlist" });
    expect(
      dockerState.createArgs.filter((a) => a["name"] === PROXY_NAME),
    ).toHaveLength(1);
    expect(dockerState.removed).not.toContain(PROXY_NAME);

    await createWorkspace({
      network: "allowlist",
      allowlistHosts: ["registry.npmjs.org", "internal.registry.dev"],
    });
    expect(dockerState.removed).toContain(PROXY_NAME);
    expect(
      dockerState.createArgs.filter((a) => a["name"] === PROXY_NAME),
    ).toHaveLength(2);
    const cfgDir = join(workspacesDir, "proxy-config");
    expect(readFileSync(join(cfgDir, "filter"), "utf8")).toContain(
      "internal.registry.dev",
    );
  });

  it("none: the container is created with no network and no proxy machinery", async () => {
    await createWorkspace({ network: "none" });
    expect(hostConfig(sandboxCreateArgs())["NetworkMode"]).toBe("none");
    expect(dockerState.builtImages).not.toContain("nightwarden-tinyproxy");
    expect(dockerState.proxyInfo).toBeNull();
    const env = sandboxCreateArgs()["Env"] as string[];
    expect(env.some((e) => e.startsWith("HTTP_PROXY="))).toBe(false);
  });

  it("open: default bridge, no proxy env", async () => {
    await createWorkspace({ network: "open" });
    expect(hostConfig(sandboxCreateArgs())["NetworkMode"]).toBeUndefined();
    expect(dockerState.proxyInfo).toBeNull();
    const env = sandboxCreateArgs()["Env"] as string[];
    expect(env.some((e) => e.startsWith("HTTPS_PROXY="))).toBe(false);
  });

  it("commands run under bash with pipefail so piped exit codes stay honest", async () => {
    const ws = await createWorkspace();
    await ws.exec("pnpm install", { timeoutMs: 60_000 });
    const cmd = dockerState.execCmds.at(-1)!;
    expect(cmd.slice(2, 6)).toEqual(["bash", "-o", "pipefail", "-lc"]);
    expect(cmd.at(-1)).toBe("pnpm install");
  });

  // A Go repository may commit vendor/, so only an install that writes it hides it.
  it("locally excludes what the repository's own installs write, and node_modules always", async () => {
    const excluded = async (files: Record<string, string>) => {
      gitState.cloneFiles = files;
      const ws = await createWorkspace();
      return readFileSync(join(`${ws.dir}.git`, "info", "exclude"), "utf8");
    };
    const php = await excluded({ "composer.lock": "{}\n" });
    expect(php).toContain("vendor/");
    expect(php).toContain("node_modules/");
    expect(await excluded({ "go.sum": "\n" })).not.toContain("vendor/");
  });

  it("reports provisioning stages in order: cloning, starting, ready (networkless skips installing)", async () => {
    const stages: string[] = [];
    await createWorkspace({ onStatus: (stage) => stages.push(stage) });
    expect(stages).toEqual(["cloning", "starting", "ready"]);
  });

  it("a provisioning failure ends the stage stream with failed", async () => {
    const stages: string[] = [];
    const sessionId = nextSessionId();
    dockerState.createFails = true;
    await expect(
      withWorkspace(
        sessionId,
        options({ onStatus: (s) => stages.push(s) }),
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("no such runtime");
    expect(stages).toEqual(["cloning", "starting", "failed"]);
  });
});

describe("boot salvage", () => {
  // Isolated per-test dir: salvage sweeps everything under it, so sharing the
  // lifecycle tests' workspacesDir would pick up their leftovers.
  let salvageDir: string;

  function salvageOpts(): Parameters<typeof salvageWorkspaces>[0] {
    return {
      workspacesDir: salvageDir,
      authHeader: () => Promise.resolve(AUTH_HEADER),
      commitAuthor: { name: "NightWarden", email: "noreply@nightwarden.local" },
    };
  }

  function makeWorkspace(name: string): string {
    const dir = join(salvageDir, name);
    mkdirSync(dir, { recursive: true });
    mkdirSync(`${dir}.git`, { recursive: true });
    mkdirSync(`${dir}.home`, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    salvageDir = createTempFolder();
  });

  it("commits dirty work, pushes to the checkout's own branch, and removes the checkout with its siblings", async () => {
    const dir = makeWorkspace("session-dirty");
    gitState.dirty = true;

    const result = await salvageWorkspaces(salvageOpts());

    expect(result).toEqual({ pushed: 1, kept: 0 });
    expect(gitState.calls.some((a) => a.includes("commit"))).toBe(true);
    const push = gitState.calls.find((a) => a.includes("push"));
    expect(push).toContain("nightwarden/fix-oom-12345678");
    expect(push?.[1]).toBe(`http.extraHeader=Authorization: ${AUTH_HEADER}`);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.git`)).toBe(false);
    expect(existsSync(`${dir}.home`)).toBe(false);
  });

  it("pushes committed-but-unpushed work without a new commit", async () => {
    makeWorkspace("session-unpushed");
    gitState.dirty = false;
    gitState.unpushed = "1";

    const result = await salvageWorkspaces(salvageOpts());

    expect(result).toEqual({ pushed: 1, kept: 0 });
    expect(gitState.calls.some((a) => a.includes("commit"))).toBe(false);
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(true);
  });

  it("removes a clean workspace without pushing anything", async () => {
    const dir = makeWorkspace("session-clean");

    const result = await salvageWorkspaces(salvageOpts());

    expect(result).toEqual({ pushed: 0, kept: 0 });
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the folder for manual recovery when the push fails", async () => {
    const warn = vi.fn();
    const dir = makeWorkspace("session-pushfail");
    gitState.dirty = true;
    gitState.failPush = true;

    const result = await salvageWorkspaces({
      ...salvageOpts(),
      log: { info: vi.fn(), warn },
    });

    expect(result).toEqual({ pushed: 0, kept: 1 });
    expect(existsSync(dir)).toBe(true);
    expect(warn).toHaveBeenCalled();
    // The auth header never leaks into the logged failure.
    const fields = warn.mock.calls[0]?.[0] as { err: string };
    expect(fields.err).toContain("[REDACTED]");
    expect(fields.err).not.toContain(AUTH_HEADER);
  });

  it("removes non-git garbage left by a crash mid-clone", async () => {
    const dir = join(salvageDir, "session-halfclone");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "half\n");

    const result = await salvageWorkspaces(salvageOpts());

    expect(result).toEqual({ pushed: 0, kept: 0 });
    expect(existsSync(dir)).toBe(false);
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(false);
  });

  it("a missing workspaces directory salvages nothing", async () => {
    rmSync(salvageDir, { recursive: true, force: true });
    const result = await salvageWorkspaces(salvageOpts());
    expect(result).toEqual({ pushed: 0, kept: 0 });
  });
});

describe("provision-time install", () => {
  async function provision(
    overrides?: Partial<WorkspaceOptions>,
  ): Promise<string> {
    const sessionId = nextSessionId();
    await withWorkspace(
      sessionId,
      options({ network: "open", ...overrides }),
      () => Promise.resolve(),
    );
    return sessionId;
  }

  it("runs mise install, then the lockfile's install, before ready, and hands the note to one taker", async () => {
    gitState.cloneFiles = { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" };
    dockerState.execHandler = (command) =>
      command === "mise ls --current"
        ? { exitCode: 0, output: "node  22.1.0  /workspace/.nvmrc  22\n" }
        : { exitCode: 0, output: "" };
    const stages: string[] = [];
    const sessionId = await provision({ onStatus: (s) => stages.push(s) });

    expect(stages).toEqual(["cloning", "starting", "installing", "ready"]);
    expect(execEvents()).toEqual([
      "mise install",
      "pnpm --version >/dev/null 2>&1 || mise use --global pnpm@10",
      "pnpm install --frozen-lockfile",
      "mise ls --current",
    ]);

    /* Only mise writes the shared runtimes, from a short-lived installer that
       cannot write the checkout; a package's own scripts run in the session. */
    const session = dockerState.createArgs[0]!;
    const installer = dockerState.createArgs[1]!;
    const binds = (args: Record<string, unknown>) =>
      (args["HostConfig"] as Record<string, unknown>)["Binds"];
    expect(installer["name"]).toBe(`nightwarden-sandbox-${sessionId}-runtimes`);
    expect(binds(installer)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/:\/workspace:ro$/),
        expect.stringMatching(/mise:\/mise$/),
      ]),
    );
    expect(binds(session)).toContain(`${join(workspacesDir, "mise")}:/mise:ro`);
    const ran = (container: string) =>
      dockerState.ranIn
        .filter((r) => r.container === container)
        .map((r) => r.command);
    expect(ran(`nightwarden-sandbox-${sessionId}-runtimes`)).toEqual([
      "mise install",
      "pnpm --version >/dev/null 2>&1 || mise use --global pnpm@10",
    ]);
    expect(ran(`nightwarden-sandbox-${sessionId}`)).toEqual([
      "pnpm install --frozen-lockfile",
      "mise ls --current",
    ]);
    expect(dockerState.removed.map((id) => dockerState.names[id])).toContain(
      `nightwarden-sandbox-${sessionId}-runtimes`,
    );
    // coreutils timeout enforces the fixed 10-minute install budget.
    expect(dockerState.execCmds[0]!.slice(0, 2)).toEqual(["timeout", "600"]);

    const note = takeSandboxNote(sessionId);
    expect(note).toContain("node  22.1.0");
    expect(note).toContain("`pnpm install --frozen-lockfile` exited 0");
    expect(takeSandboxNote(sessionId)).toBeNull();
  });

  it("fail-open: failed installs still reach ready, and the note carries each failure", async () => {
    gitState.cloneFiles = { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" };
    dockerState.execHandler = (command) => {
      if (command === "mise install") {
        return { exitCode: 2, output: "mise ERROR no such version\n" };
      }
      if (command === "pnpm install --frozen-lockfile") {
        return { exitCode: 1, output: "ERR_PNPM_SOMETHING broke\n" };
      }
      return { exitCode: 0, output: "" };
    };
    const stages: string[] = [];
    const sessionId = await provision({ onStatus: (s) => stages.push(s) });

    expect(stages).toEqual(["cloning", "starting", "installing", "ready"]);
    // A failed mise install does not stop the lockfile's install.
    expect(execEvents()).toContain("pnpm install --frozen-lockfile");
    const note = takeSandboxNote(sessionId);
    expect(note).toContain("`mise install` exited 2");
    expect(note).toContain("no such version");
    expect(note).toContain("`pnpm install --frozen-lockfile` exited 1");
    expect(note).toContain("ERR_PNPM_SOMETHING");
  });

  it("a repository with no lockfile gets mise alone, and the note says nothing was installed", async () => {
    gitState.cloneFiles = { "pom.xml": "<project/>\n" };
    const sessionId = await provision();
    expect(execEvents()).toEqual(["mise install", "mise ls --current"]);
    expect(takeSandboxNote(sessionId)).toContain("no lockfile");
  });

  it("networkless: neither mise nor an install runs, and the note says why", async () => {
    gitState.cloneFiles = { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" };
    const sessionId = await provision({ network: "none" });
    expect(execEvents()).toHaveLength(0);
    expect(takeSandboxNote(sessionId)).toContain("no network");
  });
});
