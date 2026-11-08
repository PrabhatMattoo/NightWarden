import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../db.js";
import { initSecrets } from "../secrets.js";
import { checkSecretKey, loadApiKey, updateProvider } from "../config/store.js";

function expectRestrictedPermissions(file: string): void {
  if (platform() === "win32") {
    const acl = execSync(`icacls "${file}"`).toString();
    expect(acl).not.toMatch(/Everyone/);
    expect(acl).not.toMatch(/BUILTIN\\Users/);
  } else {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
}

async function boot(): Promise<void> {
  initSecrets();
  await checkSecretKey();
}

describe("the secret key at boot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nw-secret-key-"));
    vi.stubEnv("NIGHTWARDEN_DIR", dir);
    // setup.ts sets the suite-wide test key; self-provisioning tests need
    // NIGHTWARDEN_SECRET_KEY genuinely absent.
    vi.stubEnv("NIGHTWARDEN_SECRET_KEY", undefined);
  });

  afterEach(() => {
    resetDb();
    vi.unstubAllEnvs();
    initSecrets();
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates a restricted-access key file on a fresh install, creating the state directory", async () => {
    const freshDir = join(dir, "not-yet-created");
    vi.stubEnv("NIGHTWARDEN_DIR", freshDir);

    await boot();

    expectRestrictedPermissions(join(freshDir, "secret.key"));
  });

  it("starts again on the same key and decrypts what the first boot stored", async () => {
    await boot();
    await updateProvider("anthropic", { apiKey: "sk-live-1234" });

    await boot();

    expect(await loadApiKey("anthropic")).toBe("sk-live-1234");
  });

  it("refuses to start on a different key, and a stored credential raises rather than reading as unset", async () => {
    vi.stubEnv(
      "NIGHTWARDEN_SECRET_KEY",
      "the-key-this-database-was-written-with",
    );
    await boot();
    await updateProvider("anthropic", { apiKey: "sk-live-1234" });

    vi.stubEnv("NIGHTWARDEN_SECRET_KEY", "some-other-key");
    initSecrets();

    await expect(checkSecretKey()).rejects.toThrow(join(dir, "secret.key"));
    await expect(loadApiKey("anthropic")).rejects.toThrow();
  });

  it("refuses to start over an empty or missing key file instead of generating a new one", async () => {
    await boot();
    const keyFile = join(dir, "secret.key");

    // An empty file is what a crash mid-write or a full disk leaves.
    writeFileSync(keyFile, "", { mode: 0o600 });
    await expect(boot()).rejects.toThrow(keyFile);
    expect(readFileSync(keyFile, "utf8")).toBe("");

    rmSync(keyFile);
    await expect(boot()).rejects.toThrow(keyFile);
    expect(existsSync(keyFile)).toBe(false);
  });
});
