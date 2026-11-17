import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstallPlans } from "../sandbox/install.js";
import { createTempFolder } from "./temp-folder.js";

// A repository root holding exactly these files.
function repo(files: Record<string, string>): string {
  const dir = createTempFolder();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

async function commandsFor(files: Record<string, string>): Promise<string[]> {
  return (await resolveInstallPlans(repo(files))).map((p) => p.command);
}

// Each form is the one its tool's documentation says installs from the lockfile
// and refuses to rewrite it.
describe("one lockfile, one install", () => {
  it.each([
    ["package-lock.json", "{}", "npm ci"],
    [
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n",
      "pnpm install --frozen-lockfile",
    ],
    ["uv.lock", "version = 1\n", "uv sync --locked"],
    ["poetry.lock", "", "poetry install"],
    ["Pipfile.lock", "{}", "pipenv sync"],
    ["Cargo.lock", "", "cargo fetch --locked"],
    ["go.sum", "", "go mod download"],
    ["Gemfile.lock", "", "BUNDLE_FROZEN=true bundle install"],
    ["composer.lock", "{}", "composer install --no-interaction"],
    ["mix.lock", "%{}", "mix deps.get --check-locked"],
    ["packages.lock.json", "{}", "dotnet restore --locked-mode"],
  ])("%s runs %s", async (lockfile, content, command) => {
    expect(await commandsFor({ [lockfile]: content })).toEqual([command]);
  });

  it("a pnpm lockfile gets the pnpm major that writes its format", async () => {
    const provisioned = async (version: string): Promise<string[]> =>
      (
        await resolveInstallPlans(
          repo({ "pnpm-lock.yaml": `lockfileVersion: '${version}'\n` }),
        )
      ).flatMap((p) => p.provision);

    expect(await provisioned("9.0")).toEqual(["pnpm@10"]);
    expect(await provisioned("6.0")).toEqual(["pnpm@8"]);
  });
});

describe("Yarn 1 and Yarn 2 and later", () => {
  it("reads --frozen-lockfile for Yarn 1 and --immutable for the rest", async () => {
    // The packageManager field decides first, then .yarnrc.yml, then the
    // lockfile's own header.
    expect(
      await commandsFor({
        "yarn.lock": "# yarn lockfile v1\n",
        "package.json": '{ "packageManager": "yarn@1.22.22" }',
      }),
    ).toEqual(["yarn install --frozen-lockfile"]);
    expect(
      await commandsFor({
        "yarn.lock": "# yarn lockfile v1\n",
        "package.json": '{ "packageManager": "yarn@4.1.0" }',
      }),
    ).toEqual(["yarn install --immutable"]);
    expect(
      await commandsFor({
        "yarn.lock": "",
        ".yarnrc.yml": "nodeLinker: pnp\n",
      }),
    ).toEqual(["yarn install --immutable"]);
    expect(
      await commandsFor({ "yarn.lock": "__metadata:\n  version: 8\n" }),
    ).toEqual(["yarn install --immutable"]);
    expect(await commandsFor({ "yarn.lock": "# yarn lockfile v1\n" })).toEqual([
      "yarn install --frozen-lockfile",
    ]);
  });
});

describe("a repository the table does not cover", () => {
  it("has no plan without a lockfile", async () => {
    expect(
      await commandsFor({ "pom.xml": "<project/>", "requirements.txt": "x" }),
    ).toEqual([]);
  });
});

describe("more than one lockfile", () => {
  it("installs once per ecosystem, so a Rails app with a yarn.lock gets both", async () => {
    expect(
      await commandsFor({
        "Gemfile.lock": "",
        "yarn.lock": "# yarn lockfile v1\n",
      }),
    ).toEqual([
      "yarn install --frozen-lockfile",
      "BUNDLE_FROZEN=true bundle install",
    ]);
  });

  it("within JavaScript, the package manager the repository declares wins", async () => {
    expect(
      await commandsFor({
        "package-lock.json": "{}",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "package.json": '{ "packageManager": "pnpm@10.0.0" }',
      }),
    ).toEqual(["pnpm install --frozen-lockfile"]);
  });

  it("within an ecosystem with nothing declared, the first lockfile in table order wins", async () => {
    expect(
      await commandsFor({
        "yarn.lock": "# yarn lockfile v1\n",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "package-lock.json": "{}",
      }),
    ).toEqual(["npm ci"]);
    expect(
      await commandsFor({ "Pipfile.lock": "{}", "poetry.lock": "" }),
    ).toEqual(["poetry install"]);
  });
});
