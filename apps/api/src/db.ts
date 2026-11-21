import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database, { type RunResult } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { dbPath } from "./paths.js";

// The database and a transaction share this type, so a helper takes either.
export type Db = BaseSQLiteDatabase<"sync", RunResult>;

// Beside this file in src and in dist alike, since the build copies the folder.
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

let _handle: Database.Database | undefined;
let _db: Db | undefined;

// Migrations run at open rather than only at boot, because a test reaches the
// database through getDb and would otherwise be handed one with no tables.
export function getDb(): Db {
  if (!_db) {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const handle = new Database(path);
    handle.pragma("journal_mode = WAL");
    // Off by default in SQLite, so ON DELETE CASCADE fires only once it is on.
    handle.pragma("foreign_keys = ON");
    const db = drizzle(handle);
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    _handle = handle;
    _db = db;
  }
  return _db;
}

// Eager, so a misconfigured data path or a broken migration fails at boot
// rather than at 3am.
export function initDb(): void {
  getDb();
}

// The open database, or nothing. For a caller that must not be the one to
// create it: getDb() opens one, which is a side effect an assertion cannot have.
export function openDb(): Db | undefined {
  return _db;
}

export function resetDb(): void {
  _handle?.close();
  _handle = undefined;
  _db = undefined;
}
