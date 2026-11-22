import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { getDb, resetDb } from "../db.js";
import { createTempFolder } from "./temp-folder.js";

describe("the migrations", () => {
  let dir: string;

  beforeAll(() => {
    dir = createTempFolder();
    vi.stubEnv("NIGHTWARDEN_DIR", dir);
  });

  afterAll(() => {
    resetDb();
    vi.unstubAllEnvs();
  });

  const recorded = () =>
    getDb().all(sql`SELECT * FROM __drizzle_migrations ORDER BY id`);

  it("creates every table on a database that has none", () => {
    const tables = getDb()
      .all<{ name: string }>(
        sql`SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
              AND name != '__drizzle_migrations'`,
      )
      .map((t) => t.name);
    expect(tables.sort()).toEqual([
      "account",
      "alerts",
      "audit_event",
      "auth_session",
      "config",
      "integrations",
      "mail_server",
      "provider_config",
      "runner",
      "sandbox_host_override",
      "session_transcript",
      "sessions",
      "sign_in_failure",
      "tool_result_store",
      "user",
      "verification",
    ]);
  });

  it("applies nothing on a second boot against the same directory", () => {
    const first = recorded();
    resetDb();
    expect(recorded()).toEqual(first);
  });

  it("serves the session list's whole sort from one index", () => {
    const plan = getDb().all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT s.session_id FROM sessions s
            WHERE s.investigation = 1
            ORDER BY (s.awaiting_tool_use_id IS NOT NULL) DESC,
                     s.last_activity_at DESC, s.session_id ASC
            LIMIT 21`,
    );
    const detail = plan[0]?.detail ?? "";
    expect(detail).toContain("idx_sessions_list");
    // A temp B-tree would mean every session materialises to answer one page.
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("serves one person's chat list from an index of their own", () => {
    const plan = getDb().all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT s.session_id FROM sessions s
            WHERE s.investigation = 0 AND s.created_by = 'someone'
            ORDER BY (s.awaiting_tool_use_id IS NOT NULL) DESC,
                     s.last_activity_at DESC, s.session_id ASC
            LIMIT 21`,
    );
    const detail = plan.map((row) => row.detail).join(" ");
    expect(detail).toContain("idx_sessions_creator");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  /* A half-applied schema is the one state a boot cannot recover from, so a
     failure in a later migration has to take the earlier ones back with it. */
  it("rolls every migration back when a later one fails, recording none", () => {
    const folder = createTempFolder();
    mkdirSync(join(folder, "meta"));
    const entry = (idx: number, tag: string) => ({
      idx,
      version: "6",
      when: idx + 1,
      tag,
      breakpoints: true,
    });
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [entry(0, "0000_create_probe"), entry(1, "0001_fails")],
      }),
    );
    writeFileSync(
      join(folder, "0000_create_probe.sql"),
      "CREATE TABLE probe (id TEXT);",
    );
    writeFileSync(
      join(folder, "0001_fails.sql"),
      "INSERT INTO missing VALUES (1);",
    );

    const handle = new Database(":memory:");
    onTestFinished(() => {
      handle.close();
    });
    expect(() =>
      migrate(drizzle(handle), { migrationsFolder: folder }),
    ).toThrow();
    expect(
      handle
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'probe'`)
        .all(),
    ).toEqual([]);
    expect(handle.prepare(`SELECT * FROM __drizzle_migrations`).all()).toEqual(
      [],
    );
  });
});
