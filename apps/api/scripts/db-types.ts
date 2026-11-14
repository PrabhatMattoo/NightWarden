// Generates through the boot migrator, so the types describe what a boot builds.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db.js";

const dir = mkdtempSync(join(tmpdir(), "nw-db-types-"));
try {
  const file = join(dir, "schema.db");
  const handle = new Database(file);
  applyMigrations(handle);
  handle.close();
  try {
    execFileSync("kysely-codegen", ["--url", file, ...process.argv.slice(2)], {
      stdio: "inherit",
    });
  } catch {
    // kysely-codegen has already printed its reason to the inherited stderr.
    process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
