import { randomUUID } from "node:crypto";
import type { Platform } from "@nightwarden/shared";
import { getDb } from "../db.js";
import { hashToken, issueToken, tokenMatches } from "../secrets.js";

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
export async function createRunner(
  platform: Platform,
  serverName: string,
): Promise<{ plaintext: string } & RunnerMeta> {
  const plaintext = issueToken("nwr");
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await getDb()
    .transaction()
    .execute(async (trx) => {
      // A row with this server_name that never connected is an orphan from an
      // aborted setup - free it. A connected row is real, and keeps its name.
      await trx
        .deleteFrom("runner")
        .where("server_name", "=", serverName)
        .where("last_used_at", "is", null)
        .execute();
      const inserted = await trx
        .insertInto("runner")
        .values({
          id,
          token: hashToken(plaintext),
          platform,
          server_name: serverName,
          created_at: createdAt,
        })
        .onConflict((conflict) => conflict.column("server_name").doNothing())
        .executeTakeFirst();
      if (inserted.numInsertedOrUpdatedRows === 0n) {
        throw new ServerNameTakenError(serverName);
      }
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

const META_COLUMNS = [
  "id",
  "platform",
  "server_name as serverName",
  "created_at as createdAt",
  "last_used_at as lastUsedAt",
] as const;

export async function findRunnerByToken(
  plaintext: string,
): Promise<RunnerRow | undefined> {
  /* Scanned and compared in constant time rather than looked up on the token
     index, which is the same rule the ingest credential follows. */
  for (const row of await getDb()
    .selectFrom("runner")
    .select(["token as tokenHash", ...META_COLUMNS])
    .execute()) {
    if (tokenMatches(plaintext, row.tokenHash)) return row;
  }
  return undefined;
}

// Touch last_used_at on every authenticated use (WS connect, ingest, chat).
export async function touchLastUsed(id: string): Promise<void> {
  await getDb()
    .updateTable("runner")
    .set({ last_used_at: new Date().toISOString() })
    .where("id", "=", id)
    .execute();
}

export async function deleteRunner(id: string): Promise<boolean> {
  const res = await getDb()
    .deleteFrom("runner")
    .where("id", "=", id)
    .executeTakeFirst();
  return Number(res.numDeletedRows) > 0;
}

// Public list: no hash, no plaintext, newest first.
export async function listRunnersMeta(): Promise<RunnerMeta[]> {
  return await getDb()
    .selectFrom("runner")
    .select(META_COLUMNS)
    .orderBy("created_at", "desc")
    .execute();
}
