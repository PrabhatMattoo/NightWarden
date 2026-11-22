import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { authSecretPath, secretKeyPath } from "./paths.js";
import { logger } from "./logger.js";

/* Two keys with two lifetimes: the encryption key protects credentials at rest,
   and the auth secret signs sessions. One value doing both welded them together. */
let encryption: string | null = null;
let auth: string | null = null;

// Publishing the key through process.env made the ordering an undeclared
// contract: import before boot and the failure named the env var, not why.
export function initSecrets(): void {
  encryption = readKey("NIGHTWARDEN_SECRET_KEY", secretKeyPath());
  auth =
    readKey("NIGHTWARDEN_AUTH_SECRET", authSecretPath()) ??
    writeKey(authSecretPath());
}

// First boot only: over a database that already holds encrypted data a missing
// key is refused, since a new one would read every credential as unset.
export function generateSecretKey(): void {
  encryption ??= writeKey(secretKeyPath());
}

function activeSecret(): string {
  if (encryption === null) {
    throw new Error("secrets are not initialised; initSecrets() runs at boot");
  }
  return encryption;
}

// Handed to Better Auth, which signs session tokens with it.
export function authSecret(): string {
  if (auth === null) {
    throw new Error("secrets are not initialised; initSecrets() runs at boot");
  }
  return auth;
}

function deriveKey(): Buffer {
  return createHash("sha256").update(activeSecret()).digest();
}

// AES-256-GCM: iv (12 bytes) + authTag (16 bytes) + ciphertext, hex-encoded
// and dot-separated so the three parts are trivially split on decryption.
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${ct.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const [ivHex, tagHex, ctHex, ...extra] = stored.split(".");
  if (
    ivHex === undefined ||
    tagHex === undefined ||
    ctHex === undefined ||
    extra.length > 0
  ) {
    throw new Error("Invalid encrypted value format");
  }
  const key = deriveKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return (
    decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") +
    decipher.final("utf8")
  );
}

/* A credential this API issues and afterwards only ever compares: the plaintext
   is shown once and only its hash is stored. The prefix says which kind it is. */
export function issueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// Compared in constant time, and never by looking the hash up on an index,
// because the time an index takes to answer is itself an answer.
export function tokenMatches(plaintext: string, storedHash: string): boolean {
  const presented = Buffer.from(hashToken(plaintext), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  );
}

// Provider API keys only, which a person recognises by their last four characters.
export function apiKeyHint(plaintext: string): string {
  const suffix = plaintext.slice(-4);
  return `sk-...${suffix}`;
}

/* A secret is given as NAME or as NAME_FILE naming a mounted file, never both:
   two answers to one question refuse the boot rather than pick one. */
export function readSecretEnv(name: string): string | undefined {
  const direct = process.env[name] || undefined;
  const fileVar = `${name}_FILE`;
  const path = process.env[fileVar] || undefined;
  if (direct !== undefined && path !== undefined) {
    throw new Error(`${name} and ${fileVar} are both set; set only one`);
  }
  if (path === undefined) return direct;
  let contents: string;
  try {
    contents = readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new Error(
      `${fileVar} names ${path}, which cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (contents === "") {
    throw new Error(`${fileVar} names ${path}, which is empty`);
  }
  return contents;
}

// Env wins, else a 0600 file. An empty file (crash mid-write, full disk) holds
// no recoverable key, so it reads as absent rather than as "".
function readKey(envVar: string, path: string): string | null {
  const fromEnv = readSecretEnv(envVar);
  if (fromEnv !== undefined) return fromEnv;
  if (!existsSync(path)) return null;
  const persisted = readFileSync(path, "utf8").trim();
  if (!persisted) return null;
  logger.info({ path }, `loaded persisted ${envVar} file`);
  return persisted;
}

function writeKey(path: string): string {
  const generated = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generated, { mode: 0o600 });
  if (platform() === "win32") {
    // 0o600 is ignored on Windows; restrict via ACL: remove inheritance, grant
    // only the current user full control so other local accounts cannot read it.
    execSync(`icacls "${path}" /inheritance:r /grant:r "%USERNAME%":F`, {
      stdio: "ignore",
    });
  }
  logger.info({ path }, "generated new key file");
  return generated;
}
