import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockListContainers, mockReadFile } = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mockReadFile }));

vi.mock("dockerode", () => ({
  default: vi.fn(function () {
    return { listContainers: mockListContainers };
  }),
}));

import { buildDockerManifest } from "../manifest/detect.js";
import { hideContainer } from "../docker/client.js";
import { setServerName } from "@nightwarden/runner-core";
import { composeLabels, listedContainer } from "./docker-fixtures.js";

const SERVER = "web-01";

describe("buildDockerManifest", () => {
  beforeEach(() => {
    // The API pushes this before the manifest is ever asked for, because every
    // key below is prefixed with it.
    setServerName(SERVER);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockListContainers.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("declares its platform rather than reporting what it found", async () => {
    const manifest = await buildDockerManifest();
    expect(manifest.platform).toBe("docker");
  });

  it("advertises a three-segment key built from the Compose labels, and never NightWarden's own container", async () => {
    const ownId = "a".repeat(64);
    hideContainer(ownId);
    mockListContainers.mockResolvedValue([
      listedContainer({
        Id: "c".repeat(64),
        Labels: composeLabels("myapp", "api"),
      }),
      listedContainer({
        Id: ownId,
        Labels: composeLabels("nightwarden", "api"),
      }),
    ]);

    const manifest = await buildDockerManifest();

    expect(manifest.services).toEqual([
      {
        identity: { project: "myapp", service: "api" },
        target: `${SERVER}/myapp/api`,
        status: "running",
      },
    ]);
  });

  // An unreachable daemon is a failure to report, not a reason to advertise nothing
  // and go looking for something else to be.
  it("propagates an unreachable Docker daemon instead of reporting an empty fleet", async () => {
    mockListContainers.mockRejectedValue(new Error("no docker"));
    await expect(buildDockerManifest()).rejects.toThrow(/no docker/);
  });

  describe("the advertised host name", () => {
    it("reports the host's own name, not the container id os.hostname() returns", async () => {
      vi.stubEnv("NIGHTWARDEN_HOST_PROC", "/host/proc");
      mockReadFile.mockResolvedValue("prod-web-01\n");

      const manifest = await buildDockerManifest();

      expect(manifest.hostname).toBe("prod-web-01");
    });

    it("falls back to the OS name when the host mount is not readable", async () => {
      const manifest = await buildDockerManifest();

      expect(manifest.hostname).not.toBe("");
      expect(mockReadFile).toHaveBeenCalled();
    });

    it("falls back when the file exists but is empty, rather than advertising a blank name", async () => {
      mockReadFile.mockResolvedValue("  \n");

      const manifest = await buildDockerManifest();

      expect(manifest.hostname.trim()).not.toBe("");
    });
  });
});
