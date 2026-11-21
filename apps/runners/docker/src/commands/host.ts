import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  fitList,
  type HostCpuResult,
  type HostDiskResult,
  type HostDmesgResult,
  type HostMemoryResult,
  type HostNetworkResult,
} from "@nightwarden/shared";
import type { HostDmesgInput } from "@nightwarden/shared/schemas";

const exec = promisify(execFile);
// Host /proc when the runner is containerized. Also read by manifest detection,
// which takes the runner's advertised name from the same mount.
export const PROC_PATH = process.env["NIGHTWARDEN_HOST_PROC"] ?? "/proc";

export async function getHostMemory(): Promise<HostMemoryResult> {
  const [meminfo, dmesgOut] = await Promise.all([
    readFile(`${PROC_PATH}/meminfo`, "utf8"),
    exec("dmesg", ["-T"])
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);

  const parseKb = (key: string): number => {
    const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1]!, 10) * 1024 : 0;
  };

  const total = parseKb("MemTotal");
  const available = parseKb("MemAvailable");
  const swapTotal = parseKb("SwapTotal");
  const swapFree = parseKb("SwapFree");

  // One kill prints several lines, and only "Killed process <pid> (<name>)" names
  // the victim, for a host-wide and a cgroup out-of-memory alike.
  const oomKillerEvents = dmesgOut.split("\n").flatMap((line) => {
    const killed = line.match(/Killed process \d+ \(([^)]+)\)/);
    if (killed === null) return [];
    const tsMatch = line.match(/^\[([^\]]+)\]/);
    return [
      {
        timestamp: tsMatch ? tsMatch[1]! : new Date().toISOString(),
        processName: killed[1]!,
      },
    ];
  });

  return {
    totalBytes: total,
    availableBytes: available,
    usedPercent: total > 0 ? ((total - available) / total) * 100 : 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapTotal - swapFree,
    oomKillerFired: oomKillerEvents.length > 0,
    oomKillerEvents: oomKillerEvents.slice(-10),
  };
}

export async function getHostCpu(): Promise<HostCpuResult> {
  const [stat1, loadavgStr] = await Promise.all([
    readFile(`${PROC_PATH}/stat`, "utf8"),
    readFile(`${PROC_PATH}/loadavg`, "utf8"),
  ]);

  // Two reads 100ms apart to compute delta
  await new Promise((r) => setTimeout(r, 100));
  const stat2 = await readFile(`${PROC_PATH}/stat`, "utf8");

  interface CpuRow {
    name: string;
    nums: number[];
  }

  const parseStat = (content: string): CpuRow[] =>
    content
      .split("\n")
      .filter((l) => l.startsWith("cpu"))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { name: parts[0]!, nums: parts.slice(1).map(Number) };
      });

  const s1 = parseStat(stat1);
  const s2 = parseStat(stat2);

  const computeUsage = (
    r1: CpuRow,
    r2: CpuRow,
  ): { usagePercent: number; iowaitPercent: number } => {
    // The kernel already counts guest and guest_nice, the last two fields, inside user and nice.
    const sum = (row: CpuRow): number =>
      row.nums.slice(0, 8).reduce((a, b) => a + b, 0);
    const total = sum(r2) - sum(r1);
    const idle = (r2.nums[3] ?? 0) - (r1.nums[3] ?? 0);
    const iowait = (r2.nums[4] ?? 0) - (r1.nums[4] ?? 0);
    // Waiting on the disk is reported as iowait, so it is not counted as busy too.
    return {
      usagePercent: total > 0 ? ((total - idle - iowait) / total) * 100 : 0,
      iowaitPercent: total > 0 ? (iowait / total) * 100 : 0,
    };
  };

  const cores = s1.slice(1).map((c1, i) => {
    const c2 = s2[i + 1]!;
    const { usagePercent, iowaitPercent } = computeUsage(c1, c2);
    return { id: i, usagePercent, iowaitPercent };
  });

  const overall = computeUsage(s1[0]!, s2[0]!);
  const [la1, la5, la15] = loadavgStr.trim().split(/\s+/).map(Number);

  return {
    cores,
    loadAvg1m: la1 ?? 0,
    loadAvg5m: la5 ?? 0,
    loadAvg15m: la15 ?? 0,
    overallCpuPercent: overall.usagePercent,
    overallIowaitPercent: overall.iowaitPercent,
  };
}

export async function getHostDisk(): Promise<HostDiskResult> {
  const [dfOut, iostatOut] = await Promise.all([
    exec("df", ["-Bk"]).then((r) => r.stdout),
    // -y drops the since-boot report, so the one printed covers the last second.
    exec("iostat", ["-x", "-d", "-y", "1", "1"])
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);

  const filesystems: HostDiskResult["filesystems"] = dfOut
    .trim()
    .split("\n")
    .slice(1)
    .filter((l) => !l.startsWith("tmpfs") && !l.startsWith("udev"))
    .map((l) => {
      const cols = l.trim().split(/\s+/);
      const total = parseInt(cols[1] ?? "0", 10) * 1024;
      const used = parseInt(cols[2] ?? "0", 10) * 1024;
      return {
        device: cols[0] ?? "",
        totalBytes: total,
        usedBytes: used,
        usedPercent: total > 0 ? (used / total) * 100 : 0,
        mount: cols[5] ?? cols[cols.length - 1] ?? "/",
      };
    });

  const lines = iostatOut.split("\n");
  const header = lines.find((l) => l.startsWith("Device"))?.split(/\s+/) ?? [];
  // Columns move between sysstat versions, so each is found by its header.
  const [read, write, util] = ["rkB/s", "wkB/s", "%util"].map((name) =>
    header.indexOf(name),
  );
  const diskIO: HostDiskResult["diskIO"] =
    read === -1 || write === -1 || util === -1
      ? []
      : lines
          .slice(lines.findIndex((l) => l.startsWith("Device")) + 1)
          .filter(Boolean)
          .map((l) => {
            const cols = l.trim().split(/\s+/);
            return {
              device: cols[0] ?? "",
              readBytesPerSec: parseFloat(cols[read!] ?? "0") * 1024,
              writeBytesPerSec: parseFloat(cols[write!] ?? "0") * 1024,
              utilPercent: parseFloat(cols[util!] ?? "0"),
            };
          });

  return { filesystems, diskIO };
}

export async function getHostNetwork(): Promise<HostNetworkResult> {
  // -a without -l: listening sockets and live connections both, so states can be counted.
  const { stdout } = await exec("ss", ["-tunap"]);
  const lines = stdout.trim().split("\n").filter(Boolean);

  const listeningPorts: HostNetworkResult["listeningPorts"] = [];
  const stateCounts: Record<string, number> = {};
  let totalConnections = 0;

  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    const state = cols[1] ?? "";

    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    totalConnections++;

    if (state === "LISTEN" || state === "UNCONN") {
      const localAddr = cols[4] ?? "";
      const portStr = localAddr.split(":").pop() ?? "";
      const port = parseInt(portStr, 10);
      const procMatch = line.match(/\("([^"]+)",pid=(\d+)/);
      if (!isNaN(port)) {
        listeningPorts.push({
          port,
          protocol: cols[0] ?? "tcp",
          process: procMatch ? procMatch[1]! : "unknown",
        });
      }
    }
  }

  return {
    listeningPorts,
    connectionCounts: Object.entries(stateCounts).map(([state, count]) => ({
      state,
      count,
    })),
    totalConnections,
  };
}

export async function getHostDmesg(
  input: HostDmesgInput,
): Promise<HostDmesgResult> {
  const tailLines = input.tailLines ?? 100;
  // A ladder rather than a switch: "warn" means errors as well, since a warning
  // alone rarely explains what an error next to it does.
  const LEVELS: Record<string, string[]> = {
    err: ["--level", "err"],
    warn: ["--level", "err,warn"],
    all: [],
  };
  const levelArg = LEVELS[input.filterLevel ?? "err"] ?? LEVELS["err"]!;

  const { stdout } = await exec("dmesg", ["-T", ...levelArg]).catch(async () =>
    exec("dmesg", ["-T"]),
  );

  const all = stdout.trim().split("\n").filter(Boolean);
  const { items: slice, coverage } = fitList(all, {
    keep: "end",
    max: tailLines,
    kept: "newest",
    noun: "kernel log lines",
    reach: "Raise tailLines, or narrow filterLevel, to read further back.",
  });

  let oomEventsFound = false;
  let fsErrorsFound = false;

  const lines = slice.map((raw) => {
    const tsMatch = raw.match(/^\[([^\]]+)\]/);
    const message = tsMatch ? raw.slice(tsMatch[0].length).trim() : raw;

    if (message.includes("Out of memory") || message.includes("oom-kill"))
      oomEventsFound = true;
    if (
      message.includes("EXT4-fs error") ||
      message.includes("XFS") ||
      message.includes("I/O error")
    )
      fsErrorsFound = true;

    return { timestamp: tsMatch ? tsMatch[1]! : "", message };
  });

  return {
    lines,
    oomEventsFound,
    fsErrorsFound,
    ...(coverage && { coverage }),
  };
}
