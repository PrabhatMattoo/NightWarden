import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Platform } from "@nightwarden/shared";
import { getDb } from "../db.js";
import { hashToken, issueToken, tokenMatches } from "../secrets.js";
import { runner } from "./schema.js";

// Runner record stored in DB: the SHA-256 hash (hex) of the plaintext nwr_... credential.
// Plaintext is returned once at generation and never stored or logged.
type RunnerRow = {
  id: string;
  tokenHash: string;
  platform: Platform;
  serverName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

// Public view returned by the list endpoint: no hash, no plaintext.
type RunnerMeta = {
  id: string;
  platform: Platform;
  serverName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

// Two runners of one name would make every target key under it ambiguous.
export class ServerNameTakenError extends Error {
  constructor(serverName: string) {
    super(`A runner named ${serverName} already exists`);
  }
}

// The plaintext is returned once and only its hash stored. Neither platform nor
// serverName defaults: a runner not knowing what or where it is is the bug.
export function createRunner(
  platform: Platform,
  serverName: string,
): { plaintext: string } & RunnerMeta {
  const plaintext = issueToken("nwr");
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  getDb().transaction((tx) => {
    // A row with this server_name that never connected is an orphan from an
    // aborted setup - free it. A connected row is real, and keeps its name.
    tx.delete(runner)
      .where(and(eq(runner.serverName, serverName), isNull(runner.lastUsedAt)))
      .run();
    const inserted = tx
      .insert(runner)
      .values({
        id,
        token: hashToken(plaintext),
        platform,
        serverName,
        createdAt,
      })
      .onConflictDoNothing({ target: runner.serverName })
      .run();
    if (inserted.changes === 0) throw new ServerNameTakenError(serverName);
  });

  return {
    plaintext,
    id,
    platform,
    serverName,
    createdAt,
    lastUsedAt: null,
  };
}

const META_COLUMNS = {
  id: runner.id,
  platform: runner.platform,
  serverName: runner.serverName,
  createdAt: runner.createdAt,
  lastUsedAt: runner.lastUsedAt,
};

export function findRunnerByToken(plaintext: string): RunnerRow | undefined {
  /* Scanned and compared in constant time rather than looked up on the token
     index, which is the same rule the ingest credential follows. */
  return getDb()
    .select({ tokenHash: runner.token, ...META_COLUMNS })
    .from(runner)
    .all()
    .find((row) => tokenMatches(plaintext, row.tokenHash));
}

// Touch last_used_at on every authenticated use (WS connect, ingest, chat).
export function touchLastUsed(id: string): void {
  getDb()
    .update(runner)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(runner.id, id))
    .run();
}

export function deleteRunner(id: string): boolean {
  return getDb().delete(runner).where(eq(runner.id, id)).run().changes > 0;
}

// Public list: no hash, no plaintext, newest first.
export function listRunnersMeta(): RunnerMeta[] {
  return getDb()
    .select(META_COLUMNS)
    .from(runner)
    .orderBy(desc(runner.createdAt))
    .all();
}
