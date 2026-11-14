import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { sql } from "kysely";
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
import { applyMigrations, getDb, resetDb } from "../db.js";

// The runner is the only thing standing between a schema change and a deleted
// database, so what it does on a second boot is the property worth pinning.
describe("the migration runner", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nw-mig-"));
    vi.stubEnv("NIGHTWARDEN_DIR", dir);
  });

  afterAll(() => {
    resetDb();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function appliedVersions(): Promise<number[]> {
    const rows = await getDb()
      .selectFrom("schema_migrations")
      .select("version")
      .orderBy("version")
      .execute();
    return rows.map((r) => r.version);
  }

  it("creates every table on a database that has none", async () => {
    const tables = (await getDb().introspection.getTables()).map((t) => t.name);
    expect(tables.sort()).toEqual([
      "account",
      "alerts",
      "auth_session",
      "config",
      "integrations",
      "provider_config",
      "runner",
      "schema_migrations",
      "session_transcript",
      "sessions",
      "tool_result_store",
      "user",
      "verification",
    ]);
  });

  it("applies nothing on a second boot against the same directory", async () => {
    const first = await appliedVersions();
    const stamps = await getDb()
      .selectFrom("schema_migrations")
      .select("applied_at")
      .execute();
    resetDb();
    expect(await appliedVersions()).toEqual(first);
    // A reapplied migration would rewrite its stamp, so the stamps prove it.
    expect(
      await getDb()
        .selectFrom("schema_migrations")
        .select("applied_at")
        .execute(),
    ).toEqual(stamps);
  });

  it("serves the session list's whole sort from one index", async () => {
    const plan = await sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT s.session_id FROM sessions s
         WHERE s.investigation = 1
         ORDER BY (s.awaiting_tool_use_id IS NOT NULL) DESC,
                  s.last_activity_at DESC, s.session_id ASC
         LIMIT 21`.execute(getDb());
    const detail = plan.rows[0]?.detail ?? "";
    expect(detail).toContain("idx_sessions_list");
    // A temp B-tree would mean every session materialises to answer one page.
    expect(detail).not.toContain("TEMP B-TREE");
  });
});

describe("the migrations folder", () => {
  let dir: string;
  let handle: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nw-mig-files-"));
    handle = new Database(":memory:");
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMigrations(files: Record<string, string>): URL {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    return pathToFileURL(`${dir}/`);
  }

  const recorded = () =>
    handle
      .prepare(`SELECT version, name FROM schema_migrations ORDER BY version`)
      .all();

  it("applies the files in filename order, each versioned by its prefix", () => {
    const folder = writeMigrations({
      "0002_add_note.sql": "ALTER TABLE probe ADD COLUMN note TEXT;",
      "0001_create_probe.sql": "CREATE TABLE probe (id TEXT);",
    });
    applyMigrations(handle, folder);
    expect(recorded()).toEqual([
      { version: 1, name: "create_probe" },
      { version: 2, name: "add_note" },
    ]);
  });

  it("refuses two files that claim one version", () => {
    const folder = writeMigrations({
      "0001_create_probe.sql": "CREATE TABLE probe (id TEXT);",
      "0001_create_other.sql": "CREATE TABLE other (id TEXT);",
    });
    expect(() => applyMigrations(handle, folder)).toThrow(/ascend/);
  });

  it("rolls a failing migration back whole and records nothing for it", () => {
    const folder = writeMigrations({
      "0001_create_probe.sql": "CREATE TABLE probe (id TEXT);",
      "0002_half.sql":
        "CREATE TABLE half (id TEXT); INSERT INTO missing VALUES (1);",
    });
    expect(() => applyMigrations(handle, folder)).toThrow(/migration 2/);
    expect(recorded()).toEqual([{ version: 1, name: "create_probe" }]);
    const half = handle
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`)
      .all();
    expect(half).toEqual([]);
  });
});
