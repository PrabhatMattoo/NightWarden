import { beforeEach, describe, expect, it, vi } from "vitest";

// promisify(execFile) is what host.ts calls, so the custom impl is the spy.
const { execFileAsync, readFileMock } = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  readFileMock: vi.fn(),
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = function () {} as unknown as Record<symbol, unknown>;
  execFile[promisify.custom] = execFileAsync;
  return { execFile };
});
vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

import {
  getHostCpu,
  getHostDisk,
  getHostDmesg,
  getHostMemory,
  getHostNetwork,
} from "../commands/host.js";

// Recorded on Debian 12 (the runner image's base) under Docker Desktop's Linux 7.0
// kernel: procps 4.0.2, sysstat 12.6.1, iproute2 6.1.0, util-linux 2.38.1.
const MEMINFO = `MemTotal:        8124452 kB
MemAvailable:    7309740 kB
SwapTotal:       1048572 kB
SwapFree:        1048572 kB
`;

// The three lines one cgroup out-of-memory kill printed.
const OOM_KILL = `[Mon Nov 16 17:34:11 2026] MainThread invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0
[Mon Nov 16 17:34:11 2026] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=cbabeb6dfc7f,mems_allowed=0,oom_memcg=/docker/cbabeb6dfc7f,task_memcg=/docker/cbabeb6dfc7f,task=MainThread,pid=1264,uid=0
[Mon Nov 16 17:34:11 2026] Memory cgroup out of memory: Killed process 1264 (MainThread) total-vm:1031152kB, anon-rss:29416kB, file-rss:2996kB, shmem-rss:0kB, UID:0 pgtables:432kB oom_score_adj:0
`;

// Two samples a second apart while a direct disk read and a busy loop ran.
const STAT_BEFORE = `cpu  481 0 8835 160283 770 0 203 0 0 0
cpu0 35 0 920 15694 74 0 149 0 0 0
`;
const STAT_AFTER = `cpu  581 0 8838 161162 790 0 204 0 0 0
cpu0 35 0 920 15793 74 0 149 0 0 0
`;

const DF = `Filesystem      1K-blocks      Used  Available Use% Mounted on
overlay        474044488K 37491984K 412398856K   9% /
tmpfs              65536K        0K     65536K   0% /dev
`;

// iostat -x -d -y 1 1 during a direct read of vda.
const IOSTAT = `Linux 7.0.14-linuxkit (docker-desktop) 	11/16/26 	_aarch64_	(10 CPU)


Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wkB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dkB/s   drqm/s  %drqm d_await dareq-sz     f/s f_await  aqu-sz  %util
vda           5940.59 3041584.16     0.00   0.00    0.13   512.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00    0.00    0.79  39.50
vdb              0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00    0.00    0.00   0.00


`;

// ss -tunap with one connection held open on port 5099.
const SS = `Netid State     Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
udp   UNCONN    0      0          127.0.0.1:811        0.0.0.0:*     users:(("rpc.statd",pid=211,fd=3))
udp   UNCONN    0      0            0.0.0.0:55758      0.0.0.0:*     users:(("rpc.statd",pid=211,fd=8))
udp   UNCONN    0      0            0.0.0.0:111        0.0.0.0:*     users:(("rpcbind",pid=209,fd=8))
udp   UNCONN    0      0               [::]:62445         [::]:*     users:(("rpc.statd",pid=211,fd=10))
udp   UNCONN    0      0               [::]:111           [::]:*     users:(("rpcbind",pid=209,fd=10))
tcp   LISTEN    0      4096         0.0.0.0:111        0.0.0.0:*     users:(("rpcbind",pid=209,fd=9))
tcp   LISTEN    0      4096         0.0.0.0:62249      0.0.0.0:*     users:(("rpc.statd",pid=211,fd=9))
tcp   TIME-WAIT 0      0       192.168.65.3:58340 192.168.65.1:3128
tcp   TIME-WAIT 0      0       192.168.65.3:63978 192.168.65.1:3128
tcp   TIME-WAIT 0      0       192.168.65.3:63998 192.168.65.1:3128
tcp   LISTEN    0      4096            [::]:111           [::]:*     users:(("rpcbind",pid=209,fd=11))
tcp   LISTEN    0      511                *:5099             *:*     users:(("MainThread",pid=1425,fd=21))
tcp   LISTEN    0      4096            [::]:56555         [::]:*     users:(("rpc.statd",pid=211,fd=11))
tcp   ESTAB     0      0              [::1]:5099         [::1]:58136 users:(("MainThread",pid=1425,fd=23))
tcp   TIME-WAIT 0      0              [::1]:5099         [::1]:64000
tcp   ESTAB     0      0              [::1]:58136        [::1]:5099  users:(("MainThread",pid=1425,fd=22))
`;

function serve(outputs: Record<string, string>): void {
  execFileAsync.mockImplementation((command: string) =>
    Promise.resolve({ stdout: outputs[command] ?? "" }),
  );
}

beforeEach(() => {
  execFileAsync.mockReset();
  readFileMock.mockReset();
});

describe("host vitals, read from what the host's own tools print", () => {
  it("reports one out-of-memory kill per kill, named for the process it killed", async () => {
    readFileMock.mockResolvedValue(MEMINFO);
    serve({ dmesg: OOM_KILL });

    const memory = await getHostMemory();

    expect(memory.oomKillerEvents).toEqual([
      { timestamp: "Mon Nov 16 17:34:11 2026", processName: "MainThread" },
    ]);
    // Used is what MemAvailable leaves of MemTotal.
    expect(memory.usedPercent).toBeCloseTo(
      ((8124452 - 7309740) / 8124452) * 100,
      6,
    );
  });

  it("counts time waiting on the disk as iowait and not as CPU busy", async () => {
    const samples = [STAT_BEFORE, STAT_AFTER];
    readFileMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/stat") ? samples.shift() : "0.64 0.34 0.13 1/261 1503",
      ),
    );

    const cpu = await getHostCpu();

    // Over the second: user 100, system 3, idle 879, iowait 20, softirq 1.
    const total = 100 + 3 + 879 + 20 + 1;
    expect(cpu.overallCpuPercent).toBeCloseTo(
      ((total - 879 - 20) / total) * 100,
      6,
    );
    expect(cpu.overallIowaitPercent).toBeCloseTo((20 / total) * 100, 6);
  });

  it("reads each device's rates from the columns iostat names, over the last second", async () => {
    serve({ df: DF, iostat: IOSTAT });

    const disk = await getHostDisk();

    expect(disk.diskIO).toEqual([
      {
        device: "vda",
        readBytesPerSec: 3041584.16 * 1024,
        writeBytesPerSec: 0,
        utilPercent: 39.5,
      },
      {
        device: "vdb",
        readBytesPerSec: 0,
        writeBytesPerSec: 0,
        utilPercent: 0,
      },
    ]);
    const iostatArgs = execFileAsync.mock.calls.find(
      ([command]) => command === "iostat",
    )?.[1] as string[];
    expect(iostatArgs).toContain("-y");
  });

  it("counts live connections beside listening sockets", async () => {
    serve({ ss: SS });

    const network = await getHostNetwork();

    expect(network.connectionCounts).toEqual(
      expect.arrayContaining([
        { state: "ESTAB", count: 2 },
        { state: "TIME-WAIT", count: 4 },
        { state: "LISTEN", count: 5 },
        { state: "UNCONN", count: 5 },
      ]),
    );
    expect(network.totalConnections).toBe(16);
    // A listening-only flag would hide every live connection from ss itself.
    const ssArgs = execFileAsync.mock.calls[0]?.[1] as string[];
    expect(ssArgs.some((arg) => /^-\w*l/.test(arg))).toBe(false);
    expect(network.listeningPorts).toContainEqual({
      port: 5099,
      protocol: "tcp",
      process: "MainThread",
    });
  });
});

function levelsPassedTo(call: unknown[]): string[] {
  return (call[1] as string[]).filter((arg) => arg !== "-T");
}

describe("getHostDmesg", () => {
  // A ladder, so narrowing to errors is a question the agent can actually ask:
  // err and warn selected the same two levels and neither meant what it said.
  it("selects a severity rather than treating every level alike", async () => {
    execFileAsync.mockResolvedValue({ stdout: "[Mon] Out of memory\n" });

    await getHostDmesg({ filterLevel: "err" });
    expect(levelsPassedTo(execFileAsync.mock.calls[0]!)).toEqual([
      "--level",
      "err",
    ]);

    await getHostDmesg({ filterLevel: "warn" });
    expect(levelsPassedTo(execFileAsync.mock.calls[1]!)).toEqual([
      "--level",
      "err,warn",
    ]);

    await getHostDmesg({ filterLevel: "all" });
    expect(levelsPassedTo(execFileAsync.mock.calls[2]!)).toEqual([]);
  });
});
