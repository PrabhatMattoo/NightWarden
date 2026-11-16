import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This package exists so two deployables can share code without reaching across.
// These hold the rule it was created for, which nothing else enforces.

const RUNNERS = fileURLToPath(
  new URL("../../../../apps/runners", import.meta.url),
);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist"
        ? []
        : tsFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importsIn(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("runner isolation", () => {
  const platforms = readdirSync(RUNNERS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const packageName = (platform: string): string =>
    (
      JSON.parse(
        readFileSync(join(RUNNERS, platform, "package.json"), "utf8"),
      ) as { name: string }
    ).name;

  // Neither a relative path nor the sibling's package name may cross from one
  // platform into another: what both need lives here.
  it.each(platforms)("%s reaches no sibling platform", (platform) => {
    const others = platforms.filter((p) => p !== platform);
    for (const file of tsFiles(join(RUNNERS, platform))) {
      for (const spec of importsIn(file)) {
        for (const other of others) {
          const crosses = spec.startsWith(".")
            ? join(file, "..", spec).startsWith(join(RUNNERS, other))
            : spec === packageName(other) ||
              spec.startsWith(`${packageName(other)}/`);
          expect(crosses, `${file} imports ${spec}, which is ${other}'s`).toBe(
            false,
          );
        }
      }
    }
  });

  // A folder here that is not itself a runner is shared code by another name,
  // and shared code belongs in a package rather than beside its consumers.
  it("holds nothing but runners", () => {
    for (const platform of platforms) {
      const manifest = join(RUNNERS, platform, "package.json");
      expect(
        statSync(manifest, { throwIfNoEntry: false }) !== undefined,
        `apps/runners/${platform} has no package.json, so it is not a deployable`,
      ).toBe(true);
    }
  });
});
