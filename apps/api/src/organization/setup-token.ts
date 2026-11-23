import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { logger } from "../logger.js";
import { setupTokenPath } from "../paths.js";
import { configuredPublicUrl } from "../public-url.js";
import { organizationExists } from "./organization-store.js";

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

export function writeSetupToken(token: string): void {
  writeFileSync(setupTokenPath(), token, { mode: 0o600 });
}

// A fresh token on every boot of an install with no owner, and none once it has one.
export function prepareSetup(): void {
  rmSync(setupTokenPath(), { force: true });
  if (organizationExists()) return;
  const token = randomBytes(32).toString("base64url");
  writeSetupToken(token);
  const publicUrl = configuredPublicUrl();
  logger.info(
    publicUrl === undefined
      ? `Finish setup: enter the token ${token} on the setup page. It is also in ${setupTokenPath()}`
      : `Finish setup: ${publicUrl}/setup#token=${token}`,
  );
}

// No await between the read and the delete, so one request wins the token.
export function claimSetupToken(presented: string): boolean {
  let stored: Buffer;
  try {
    stored = readFileSync(setupTokenPath());
  } catch (err) {
    if (isMissingFile(err)) return false;
    throw err;
  }
  const offered = Buffer.from(presented);
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
    return false;
  }
  unlinkSync(setupTokenPath());
  return true;
}
