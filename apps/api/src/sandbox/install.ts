import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { capOutput } from "./output.js";

// A fixed rule, never the agent's judgement: each lockfile at the repository
// root names the one install that reads it without rewriting it.
export interface InstallPlan {
  lockfile: string;
  command: string;
  // Exits 0 when the command's tool is on the PATH.
  probe: string;
  // mise tools that supply the tool when the repository does not pin it.
  provision: string[];
  // What the install writes inside the checkout, kept out of checkpoint commits.
  writes: string[];
}

interface StepResult {
  exitCode: number;
  output: string;
}

export type RunStep = (
  command: string,
  timeoutMs: number,
) => Promise<StepResult>;

const INSTALL_BUDGET_MS = 10 * 60_000;
const OUTPUT_TAIL_CHARS = 2000;

const NPM_PLAN: InstallPlan = {
  lockfile: "package-lock.json",
  command: "npm ci",
  probe: "npm --version",
  provision: [],
  writes: ["node_modules/"],
};

// A pnpm lockfile is readable only by the majors that write its format.
function pnpmMajorFor(lockfile: string): string {
  const version = /^lockfileVersion:\s*['"]?(\d+)/m.exec(lockfile)?.[1];
  if (version === "9") return "pnpm@10";
  if (version === "6") return "pnpm@8";
  if (version === "5") return "pnpm@7";
  return "pnpm@latest";
}

// Debian's python3 lacks ensurepip, so poetry and pipenv install through uv.
const PIPX_TOOLS = ["uv", "python@3.12"];

const PYTHON_PLANS: InstallPlan[] = [
  {
    lockfile: "uv.lock",
    command: "uv sync --locked",
    probe: "uv --version",
    provision: ["uv"],
    writes: [".venv/"],
  },
  {
    lockfile: "poetry.lock",
    command: "poetry install",
    probe: "poetry --version",
    provision: PIPX_TOOLS.concat("pipx:poetry"),
    writes: [],
  },
  {
    lockfile: "Pipfile.lock",
    command: "pipenv sync",
    probe: "pipenv --version",
    provision: PIPX_TOOLS.concat("pipx:pipenv"),
    writes: [],
  },
];

// composer and mix need php or Erlang, which mise compiles from source, so
// they run only where the repository pins that runtime.
const OTHER_PLANS: InstallPlan[] = [
  {
    lockfile: "Cargo.lock",
    command: "cargo fetch --locked",
    probe: "cargo --version",
    provision: ["rust"],
    writes: [],
  },
  {
    lockfile: "go.sum",
    command: "go mod download",
    probe: "go version",
    provision: ["go"],
    writes: [],
  },
  {
    lockfile: "Gemfile.lock",
    command: "BUNDLE_FROZEN=true bundle install",
    probe: "bundle --version",
    provision: ["ruby"],
    writes: [],
  },
  {
    lockfile: "composer.lock",
    command: "composer install --no-interaction",
    probe: "composer --version",
    provision: [],
    writes: ["vendor/"],
  },
  {
    lockfile: "mix.lock",
    command: "mix deps.get --check-locked",
    probe: "mix --version",
    provision: [],
    writes: ["deps/", "_build/"],
  },
  {
    lockfile: "packages.lock.json",
    command: "dotnet restore --locked-mode",
    probe: "dotnet --version",
    provision: ["dotnet"],
    writes: ["obj/"],
  },
];

async function readText(dir: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(dir, name), "utf8");
  } catch {
    return null;
  }
}

// The package.json `packageManager` field, such as "yarn@4.1.0".
function declaredPackageManager(packageJson: string | null): string {
  if (packageJson === null) return "";
  try {
    const parsed: unknown = JSON.parse(packageJson);
    return typeof parsed === "object" &&
      parsed !== null &&
      "packageManager" in parsed &&
      typeof parsed.packageManager === "string"
      ? parsed.packageManager
      : "";
  } catch {
    // A malformed package.json reads as unpinned, never as a failure.
    return "";
  }
}

// Yarn 2 and later read `--immutable`; Yarn 1 reads `--frozen-lockfile`.
async function yarnPlan(
  dir: string,
  files: Set<string>,
  declared: string,
): Promise<InstallPlan> {
  const major = /^yarn@(\d+)/.exec(declared)?.[1];
  const berry =
    major !== undefined
      ? major !== "1"
      : files.has(".yarnrc.yml") ||
        ((await readText(dir, "yarn.lock")) ?? "").includes("__metadata:");
  return berry
    ? {
        lockfile: "yarn.lock",
        command: "yarn install --immutable",
        probe: '[ "$(yarn --version | cut -d. -f1)" -ge 2 ]',
        provision: ["yarn@4"],
        writes: ["node_modules/", ".yarn/install-state.gz"],
      }
    : {
        lockfile: "yarn.lock",
        command: "yarn install --frozen-lockfile",
        probe: "yarn --version",
        provision: ["yarn@1"],
        writes: ["node_modules/"],
      };
}

// One plan per ecosystem. Within one, the package manager the repository
// declares wins, then the first lockfile in table order.
export async function resolveInstallPlans(dir: string): Promise<InstallPlan[]> {
  const files = new Set(await readdir(dir));
  const plans: InstallPlan[] = [];

  const packageJson = await readText(dir, "package.json");
  const declared = declaredPackageManager(packageJson);
  const js: Array<[string, string, () => Promise<InstallPlan>]> = [
    ["npm", "package-lock.json", () => Promise.resolve(NPM_PLAN)],
    [
      "pnpm",
      "pnpm-lock.yaml",
      async () => ({
        lockfile: "pnpm-lock.yaml",
        command: "pnpm install --frozen-lockfile",
        probe: "pnpm --version",
        provision: [
          pnpmMajorFor((await readText(dir, "pnpm-lock.yaml")) ?? ""),
        ],
        writes: ["node_modules/"],
      }),
    ],
    ["yarn", "yarn.lock", () => yarnPlan(dir, files, declared)],
  ];
  const present = js.filter(([, lockfile]) => files.has(lockfile));
  const chosen =
    present.find(([name]) => declared.startsWith(`${name}@`)) ?? present[0];
  if (chosen !== undefined) plans.push(await chosen[2]());

  const python = PYTHON_PLANS.find((plan) => files.has(plan.lockfile));
  if (python !== undefined) plans.push(python);
  plans.push(...OTHER_PLANS.filter((plan) => files.has(plan.lockfile)));
  return plans;
}

function tailOf(output: string): string {
  return capOutput(output).text.slice(-OUTPUT_TAIL_CHARS);
}

function failure(what: string, result: StepResult): string {
  const how =
    result.exitCode === 124 ? "timed out" : `exited ${String(result.exitCode)}`;
  return `${what} ${how}. The last ${String(OUTPUT_TAIL_CHARS)} characters of its output:\n<output>\n${tailOf(result.output)}\n</output>`;
}

// Fail-open: every outcome, a thrown exec included, becomes text for the model
// and the sandbox still comes up. Runtimes install through `runtimes`, the only
// step that may write the shared directory; package scripts run in `session`.
export async function installRepository(
  runtimes: RunStep,
  session: RunStep,
  plans: InstallPlan[],
): Promise<string> {
  const deadline = Date.now() + INSTALL_BUDGET_MS;
  const sections: string[] = [];

  async function step(run: RunStep, command: string): Promise<StepResult> {
    const remaining = deadline - Date.now();
    if (remaining < 1000) {
      return { exitCode: 124, output: "The install budget was used up." };
    }
    try {
      return await run(command, remaining);
    } catch (err) {
      return {
        exitCode: 1,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const pinned = await step(runtimes, "mise install");
  if (pinned.exitCode !== 0) {
    sections.push(failure("`mise install`", pinned));
  }

  for (const plan of plans) {
    const prepare =
      plan.provision.length === 0
        ? plan.probe
        : `${plan.probe} >/dev/null 2>&1 || mise use --global ${plan.provision.join(" ")}`;
    const prepared = await step(runtimes, prepare);
    if (prepared.exitCode !== 0) {
      sections.push(
        failure(
          `Making the tool for ${plan.lockfile} available (\`${prepare}\`)`,
          prepared,
        ),
      );
      continue;
    }
    const installed = await step(session, plan.command);
    sections.push(
      installed.exitCode === 0
        ? `Dependencies from ${plan.lockfile} are installed: \`${plan.command}\` exited 0.`
        : failure(`Dependency install \`${plan.command}\``, installed),
    );
  }
  if (plans.length === 0) {
    sections.push(
      "The repository root has no lockfile that the sandbox installs from, so no dependencies were installed.",
    );
  }

  // Its own bound, so a spent install budget still reports what was resolved.
  const resolved = await session("mise ls --current", 30_000).then(
    (result) => (result.exitCode === 0 ? result.output.trim() : ""),
    () => "",
  );
  sections.unshift(
    resolved === ""
      ? "mise found no runtime pinned by the repository."
      : `Runtimes mise resolved for the repository (tool, version, pinned by, requested):\n<runtimes>\n${resolved}\n</runtimes>`,
  );
  return sections.join("\n\n");
}
