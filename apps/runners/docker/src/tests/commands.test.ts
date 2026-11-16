import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockDocker } = vi.hoisted(() => ({ MockDocker: vi.fn() }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import {
  getContainerInspect,
  getContainerProcesses,
  getContainerStats,
  restartContainer,
} from "../docker/commands.js";
import {
  inspectedState,
  listedContainer,
  RECORDED_ENV,
  RECORDED_STATS,
  RECORDED_TOP,
} from "./docker-fixtures.js";

const SERVICE = { project: "shop", service: "postgres" };
const LIVE_ID = "1".repeat(64);

interface FakeContainer {
  inspect: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  stats: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
}

function engineWith(state: string, container: Partial<FakeContainer>) {
  const fake: FakeContainer = {
    inspect: vi.fn(),
    restart: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn(),
    top: vi.fn(),
    ...container,
  };
  const getContainer = vi.fn().mockReturnValue(fake);
  MockDocker.mockImplementation(function () {
    return {
      listContainers: vi
        .fn()
        .mockResolvedValue([listedContainer({ Id: LIVE_ID, State: state })]),
      getContainer,
    };
  });
  return { fake, getContainer };
}

const RESTART = {
  service: SERVICE,
  reason: "wedged",
  estimatedDowntimeSeconds: 5,
};

describe("restartContainer", () => {
  beforeEach(() => MockDocker.mockReset());

  it("restarts the live container and reports success once it settles running", async () => {
    const { fake, getContainer } = engineWith("running", {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({ State: inspectedState("running", 137) })
        .mockResolvedValue({ State: inspectedState("running") }),
    });

    const result = await restartContainer(RESTART);

    expect(getContainer).toHaveBeenCalledWith(LIVE_ID);
    expect(fake.restart).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      newStatus: "running",
      previousExitCode: 137,
    });
  });

  it("reports a restart that settled exited as a failure, so the agent is not told it fixed anything", async () => {
    engineWith("running", {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({ State: inspectedState("running") })
        .mockResolvedValue({ State: inspectedState("exited", 1) }),
    });

    expect(await restartContainer(RESTART)).toMatchObject({
      success: false,
      newStatus: "exited",
    });
  });

  it("restarts nothing when no instance is live", async () => {
    const { fake } = engineWith("exited", {});

    expect(await restartContainer(RESTART)).toMatchObject({ found: false });
    expect(fake.restart).not.toHaveBeenCalled();
  });
});

describe("what leaves the host", () => {
  beforeEach(() => MockDocker.mockReset());

  it("names a container's environment variables and never their values", async () => {
    engineWith("running", {
      inspect: vi.fn().mockResolvedValue({
        Name: "/shop-postgres",
        Image: "sha256:3b0c",
        Created: "2026-11-14T07:56:47.677512671Z",
        Mounts: [],
        Config: { Image: "postgres:17.11-trixie", Env: RECORDED_ENV },
        NetworkSettings: { Ports: {} },
        HostConfig: { RestartPolicy: { Name: "no" } },
        State: inspectedState("running"),
      }),
    });

    const result = await getContainerInspect({ service: SERVICE });

    expect(result).toMatchObject({
      envVarNames: [
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD",
        "PATH",
        "PGDATA",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("redacts a secret on a process's command line", async () => {
    const row = [...RECORDED_TOP.Processes[0]!];
    row[7] = "mysqld --password=s3cret-pass";
    engineWith("running", {
      top: vi.fn().mockResolvedValue({ ...RECORDED_TOP, Processes: [row] }),
    });

    const result = await getContainerProcesses({ service: SERVICE });

    expect(JSON.stringify(result)).not.toContain("s3cret-pass");
  });
});

describe("getContainerStats", () => {
  beforeEach(() => MockDocker.mockReset());

  // Expected values follow docker stats: CPU over the sampled interval, memory less reclaimable page cache.
  it("reads a cgroup v2 engine's usage as docker stats does", async () => {
    engineWith("running", {
      stats: vi.fn().mockResolvedValue(RECORDED_STATS),
    });

    const result = await getContainerStats({ service: SERVICE });

    expect(result).toMatchObject({
      memoryUsedBytes: 549703680 - 230764544,
      blockReadBytes: 178380800,
      blockWriteBytes: 327254016,
      networkRxBytes: 35621905,
      pids: 12,
    });
    const cpu =
      ((97165215000 - 97149346000) / (21808980000000 - 21799070000000)) *
      10 *
      100;
    expect((result as { cpuPercent: number }).cpuPercent).toBeCloseTo(cpu, 6);
  });
});
