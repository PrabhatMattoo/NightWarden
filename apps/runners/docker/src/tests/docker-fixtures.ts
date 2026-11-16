// Trimmed from Docker Engine 29 on cgroup v2: the fields the runner reads, with recorded values.
import type Dockerode from "dockerode";

export function composeLabels(
  project: string,
  service: string,
): Record<string, string> {
  return {
    "com.docker.compose.container-number": "1",
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
  };
}

// A running shop/postgres, as the engine lists it; a test overrides the fields its story turns on.
export function listedContainer(
  container: Partial<Dockerode.ContainerInfo> & { Id: string },
): Dockerode.ContainerInfo {
  return {
    Names: ["/shop-postgres"],
    Image: "postgres:17.11-trixie",
    ImageID:
      "sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1",
    Command: "docker-entrypoint.sh postgres",
    Created: 1794643007,
    Ports: [
      { IP: "0.0.0.0", PrivatePort: 5432, PublicPort: 5433, Type: "tcp" },
    ],
    Labels: composeLabels("shop", "postgres"),
    State: "running",
    Status: "Up 35 minutes (healthy)",
    HostConfig: { NetworkMode: "shop_default" },
    NetworkSettings: { Networks: {} },
    Mounts: [],
    ...container,
  };
}

export function inspectedState(status: string, exitCode = 0) {
  return {
    Status: status,
    Running: status === "running",
    Restarting: false,
    ExitCode: exitCode,
    StartedAt: "2026-11-16T09:31:28.017772005Z",
  };
}

export const RECORDED_ENV = [
  "POSTGRES_DB=shop",
  "POSTGRES_USER=shop",
  "POSTGRES_PASSWORD=hunter2-recorded-placeholder",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "PGDATA=/var/lib/postgresql/data",
];

export const RECORDED_STATS = {
  cpu_stats: {
    cpu_usage: { total_usage: 97165215000 },
    system_cpu_usage: 21808980000000,
    online_cpus: 10,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 97149346000 },
    system_cpu_usage: 21799070000000,
    online_cpus: 10,
  },
  memory_stats: {
    usage: 549703680,
    limit: 8321515520,
    stats: { inactive_file: 230764544 },
  },
  pids_stats: { current: 12 },
  networks: { eth0: { rx_bytes: 35621905, tx_bytes: 25586391 } },
  blkio_stats: {
    io_service_bytes_recursive: [
      { major: 254, minor: 0, op: "read", value: 178380800 },
      { major: 254, minor: 0, op: "write", value: 327254016 },
    ],
  },
};

export const RECORDED_TOP = {
  Titles: ["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"],
  Processes: [["999", "925", "788", "0", "09:31", "?", "00:00:00", "postgres"]],
};
