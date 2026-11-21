import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { execFileMock, MockDocker } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  MockDocker: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import { useTempDb } from "./temp-db.js";
import { updateConfig } from "../config/store.js";
import { saveGitHubIntegration } from "../integrations/store.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { releaseContainers } from "../sandbox/workspace.js";
import type { DispatchedToolResult } from "../agent/tools/types.js";
import { parsedContent } from "./tool-result.js";
import { requestBody, requestMethod, requestUrl } from "./wire-helper.js";

const SESSION_ID = "ccccdddd-0000-4000-8000-000000000001";

const FIXTURE: Record<string, string> = {
  "package.json":
    '{ "name": "fixture", "scripts": { "test": "vitest run" } }\n',
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "src/app.ts": "export const a = 1;\n",
};

const gitState = {
  dirty: true,
  unpushed: "0",
  calls: [] as string[][],
};

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function installGitMock(): void {
  execFileMock.mockImplementation((...fnArgs: unknown[]) => {
    const args = fnArgs[1] as string[];
    const cb = fnArgs[fnArgs.length - 1] as ExecCb;
    const stripped = [...args];
    while (stripped[0] === "-c") stripped.splice(0, 2);
    const sub = stripped[0] ?? "";
    gitState.calls.push(args);
    const ok = (stdout = ""): void => cb(null, stdout, "");
    switch (sub) {
      case "clone": {
        const dir = stripped[stripped.length - 1]!;
        // A real clone always yields info/ in its git dir (the local-exclude
        // append depends on it), so the double must too.
        const gitDir = stripped.find((a) =>
          a.startsWith("--separate-git-dir="),
        )!;
        mkdirSync(join(gitDir.slice("--separate-git-dir=".length), "info"), {
          recursive: true,
        });
        for (const [rel, content] of Object.entries(FIXTURE)) {
          mkdirSync(join(dir, rel, ".."), { recursive: true });
          writeFileSync(join(dir, rel), content);
        }
        return ok();
      }
      case "rev-parse":
        return cb(new Error("fatal: Needed a single revision"), "", "fatal");
      case "status":
        return ok(gitState.dirty ? " M src/app.ts\n" : "");
      case "commit":
        gitState.dirty = false;
        gitState.unpushed = "1";
        return ok();
      case "rev-list":
        return ok(`${gitState.unpushed}\n`);
      case "push":
        gitState.unpushed = "0";
        return ok();
      case "diff":
        return ok("src/app.ts\n");
      default:
        return ok();
    }
  });
}

const dockerState = {
  execExit: 0,
  execCmds: [] as string[][],
  imageLabels: {} as Record<string, Record<string, string>>,
};

function installDockerMock(): void {
  // Function expression: getDocker() constructs with `new`.
  MockDocker.mockImplementation(function () {
    return {
      ping: () => Promise.resolve({}),
      getImage: (name: string) => ({
        inspect: () =>
          dockerState.imageLabels[name]
            ? Promise.resolve({
                Config: { Labels: dockerState.imageLabels[name] },
              })
            : Promise.reject(new Error("no such image")),
      }),
      buildImage: (
        _ctx: unknown,
        opts: { t: string; labels?: Record<string, string> },
      ) => {
        dockerState.imageLabels[opts.t] = opts.labels ?? {};
        return Promise.resolve({});
      },
      modem: {
        followProgress: (
          _stream: unknown,
          cb: (err: Error | null, events: unknown[]) => void,
        ) => cb(null, []),
      },
      createContainer: () =>
        Promise.resolve({ id: "sandbox-opr", start: () => Promise.resolve() }),
      getContainer: () => ({
        remove: () => Promise.resolve(),
        exec: (opts: { Cmd: string[] }) => {
          dockerState.execCmds.push(opts.Cmd);
          const exitCode = dockerState.execExit;
          const stream = new PassThrough();
          process.nextTick(() => {
            stream.write(Buffer.from("container exec output\n"));
            stream.end();
          });
          return Promise.resolve({
            start: () => Promise.resolve(stream),
            inspect: () => Promise.resolve({ ExitCode: exitCode }),
          });
        },
      }),
      listContainers: () => Promise.resolve([]),
    };
  });
}

interface PrState {
  open: Array<{ number: number; html_url: string; draft: boolean }>;
  rejectDraft: boolean;
  // A status GitHub answers every create with, such as a gateway error.
  createStatus?: number;
  createPayloads: Array<Record<string, unknown>>;
  patchPayloads: Array<Record<string, unknown>>;
}
const prState: PrState = {
  open: [],
  rejectDraft: false,
  createPayloads: [],
  patchPayloads: [],
};

function installGitHubMock(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.includes("/pulls?state=open")) return json(prState.open);
      if (url.includes("/pulls/") && method === "PATCH") {
        prState.patchPayloads.push(
          JSON.parse(await requestBody(input, init)) as Record<string, unknown>,
        );
        return json({});
      }
      if (url.endsWith("/pulls") && method === "POST") {
        const payload = JSON.parse(await requestBody(input, init)) as Record<
          string,
          unknown
        >;
        prState.createPayloads.push(payload);
        if (prState.createStatus !== undefined) {
          return json({ message: "Bad Gateway" }, prState.createStatus);
        }
        if (payload["draft"] === true && prState.rejectDraft) {
          return json(
            {
              message:
                "Draft pull requests are not supported in this repository.",
            },
            422,
          );
        }
        return json(
          {
            number: 42,
            html_url: "https://github.com/acme/api/pull/42",
            draft: payload["draft"] === true,
          },
          201,
        );
      }
      if (url.includes("/repos/acme/api")) {
        return json({ default_branch: "main" });
      }
      return json({});
    }),
  );
}

let cleanupDb: () => void;
let toolUseCounter = 0;

async function runOpr(
  input: Record<string, unknown>,
  sessionId = SESSION_ID,
  toolCallId = `opr-${++toolUseCounter}`,
): Promise<DispatchedToolResult> {
  const entry = findTool("OpenPullRequest");
  if (!entry) throw new Error("OpenPullRequest missing from registry");
  return await executeTool(entry, input, {
    toolCallCeilingMs: 15_000,
    sessionId,
    toolCallId,
  });
}

beforeAll(() => {
  cleanupDb = useTempDb();
  // Network detachment is covered in sandbox-workspace tests; keep this
  // PR-focused test on the open path so the mock needs no network machinery.
  updateConfig({ sandboxNetwork: "open" });
  installGitMock();
  installDockerMock();
  installGitHubMock();
  saveGitHubIntegration({
    token: "github_pat_fixture",
    repoOwner: "acme",
    repoName: "api",
    tokenExpiresAt: null,
  });
});

afterAll(async () => {
  await releaseContainers();
  cleanupDb();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenPullRequest", () => {
  it("pushes, creates a draft PR with the composed body, and settles the audit row", async () => {
    gitState.dirty = true;
    const result = await runOpr(
      { title: "Fix payments OOM", body: "The cache grew unbounded." },
      SESSION_ID,
      "opr-create",
    );

    expect(result.isError).toBeUndefined();
    const toolOutcome = parsedContent<{
      action: string;
      number: number;
      url: string;
      draft: boolean;
      message: string;
    }>(result);
    expect(toolOutcome.action).toBe("created");
    expect(toolOutcome.number).toBe(42);
    expect(toolOutcome.draft).toBe(true);
    expect(toolOutcome.message).toContain("draft PR #42");
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(true);

    const payload = prState.createPayloads.at(-1)!;
    expect(payload["draft"]).toBe(true);
    expect(payload["base"]).toBe("main");
    const body = String(payload["body"]);
    expect(body).toContain("The cache grew unbounded.");
    expect(body).toContain("## Incident");
    expect(body).toContain("## Files changed");
    expect(body).toContain("- src/app.ts");
    // The gate is gone by design: the body carries no verification section.
    expect(body).not.toContain("## Verification");
    expect(body).toContain(SESSION_ID);
  });

  // A retry after a crash finds the PR by its branch, so no stored attempt is needed.
  it("updates the PR its branch already opened instead of duplicating it", async () => {
    prState.open = [
      {
        number: 42,
        html_url: "https://github.com/acme/api/pull/42",
        draft: true,
      },
    ];
    gitState.dirty = true;
    const before = prState.createPayloads.length;

    const result = await runOpr(
      { title: "Fix payments OOM (v2)" },
      SESSION_ID,
      "opr-update",
    );
    prState.open = [];

    expect(result.isError).toBeUndefined();
    const toolOutcome = parsedContent<{ action: string; message: string }>(
      result,
    );
    expect(toolOutcome.action).toBe("updated");
    expect(toolOutcome.message).toContain("Updated existing PR #42");
    expect(prState.createPayloads).toHaveLength(before);
    expect(prState.patchPayloads.at(-1)?.["title"]).toBe(
      "Fix payments OOM (v2)",
    );
  });

  it("falls back to a regular PR when the plan rejects drafts, and says so", async () => {
    prState.rejectDraft = true;
    gitState.dirty = true;
    const result = await runOpr(
      { title: "Fix it" },
      SESSION_ID,
      "opr-fallback",
    );
    prState.rejectDraft = false;

    expect(result.isError).toBeUndefined();
    const toolOutcome = parsedContent<{ draft: boolean; message: string }>(
      result,
    );
    expect(toolOutcome.draft).toBe(false);
    expect(toolOutcome.message).toContain("draft mode is unavailable");
    const attempts = prState.createPayloads.slice(-2);
    expect(attempts[0]?.["draft"]).toBe(true);
    expect(attempts[1]?.["draft"]).toBe(false);
  });

  it("says there is nothing to propose, without asking GitHub, when the branch has no commits", async () => {
    // GitHub answers an empty diff with a bare 422, which reads as a broken
    // token; the user then reconnects a credential that was working.
    gitState.dirty = false;
    gitState.unpushed = "0";
    gitState.calls.length = 0;
    const requestsBefore = prState.createPayloads.length;

    const result = await runOpr({ title: "Fix it" }, SESSION_ID, "opr-nodiff");

    expect(result.isError).toBeUndefined();
    const toolOutcome = parsedContent<{ action: string; message: string }>(
      result,
    );
    expect(toolOutcome.action).toBe("nothing_to_propose");
    expect(toolOutcome.message).toContain("nothing to propose");
    expect(prState.createPayloads).toHaveLength(requestsBefore);
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(false);
  });

  // A 502 can arrive after GitHub opened the PR, so a second create could duplicate it.
  it("sends a create once when GitHub answers it with a gateway error", async () => {
    prState.createStatus = 502;
    gitState.dirty = true;
    const before = prState.createPayloads.length;

    const result = await runOpr({ title: "Fix it" }, SESSION_ID, "opr-502");
    prState.createStatus = undefined;

    expect(result.isError).toBe(true);
    expect(prState.createPayloads).toHaveLength(before + 1);
  });
});
