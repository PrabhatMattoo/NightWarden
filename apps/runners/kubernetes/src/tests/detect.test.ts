import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  V1DaemonSet,
  V1Deployment,
  V1StatefulSet,
} from "@kubernetes/client-node";

const { mockListDeployments, mockListStatefulSets, mockListDaemonSets } =
  vi.hoisted(() => ({
    mockListDeployments: vi.fn(),
    mockListStatefulSets: vi.fn(),
    mockListDaemonSets: vi.fn(),
  }));

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: vi.fn(function () {
    return {
      loadFromDefault: vi.fn(),
      loadFromCluster: vi.fn(),
      makeApiClient: (Api: { name: string }) => {
        if (Api.name !== "AppsV1Api") throw new Error(`unexpected ${Api.name}`);
        return {
          listDeploymentForAllNamespaces: mockListDeployments,
          listStatefulSetForAllNamespaces: mockListStatefulSets,
          listDaemonSetForAllNamespaces: mockListDaemonSets,
        };
      },
    };
  }),
  AppsV1Api: class AppsV1Api {},
  CoreV1Api: class CoreV1Api {},
}));

import { buildKubernetesManifest } from "../manifest/detect.js";
import { setServerName } from "@nightwarden/runner-core";

// Typed as the client's own models, so a field the API does not send fails to compile.
function deployment(
  namespace: string,
  name: string,
  readyReplicas: number,
): V1Deployment {
  return {
    metadata: { namespace, name },
    status: { replicas: readyReplicas, readyReplicas },
  };
}

function statefulSet(
  namespace: string,
  name: string,
  readyReplicas: number,
): V1StatefulSet {
  return {
    metadata: { namespace, name },
    status: { replicas: readyReplicas, readyReplicas },
  };
}

function daemonSet(
  namespace: string,
  name: string,
  numberReady: number,
): V1DaemonSet {
  return {
    metadata: { namespace, name },
    status: {
      currentNumberScheduled: 4,
      desiredNumberScheduled: 4,
      numberMisscheduled: 0,
      numberReady,
    },
  };
}

const SERVER = "prod-cluster";

describe("buildKubernetesManifest", () => {
  beforeEach(() => {
    // The API pushes this before the manifest is ever asked for, because every
    // key below is prefixed with it.
    setServerName(SERVER);
    mockListDeployments.mockResolvedValue({ items: [] });
    mockListStatefulSets.mockResolvedValue({ items: [] });
    mockListDaemonSets.mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("declares its platform rather than reporting what it found", async () => {
    const manifest = await buildKubernetesManifest();
    expect(manifest.platform).toBe("kubernetes");
  });

  it("advertises a three-segment key built from namespace and workload, and carries it", async () => {
    mockListDeployments.mockResolvedValue({
      items: [deployment("production", "api-server", 2)],
    });

    const manifest = await buildKubernetesManifest();

    expect(manifest.services).toEqual([
      {
        identity: { namespace: "production", workload: "api-server" },
        target: `${SERVER}/production/api-server`,
        status: "running",
        kind: "Deployment",
      },
    ]);
  });

  it("advertises all three kinds and stamps the kind the alert resolver needs", async () => {
    mockListDeployments.mockResolvedValue({
      items: [deployment("shop", "api", 1)],
    });
    mockListStatefulSets.mockResolvedValue({
      items: [statefulSet("shop", "db", 3)],
    });
    mockListDaemonSets.mockResolvedValue({
      items: [daemonSet("kube-system", "node-exporter", 4)],
    });

    const manifest = await buildKubernetesManifest();

    expect(manifest.services.map((s) => [s.identity.workload, s.kind])).toEqual(
      [
        ["api", "Deployment"],
        ["db", "StatefulSet"],
        ["node-exporter", "DaemonSet"],
      ],
    );
  });

  it("reads a DaemonSet's readiness from numberReady, which counts nodes not replicas", async () => {
    mockListDaemonSets.mockResolvedValue({
      items: [
        daemonSet("kube-system", "ready-agent", 2),
        daemonSet("kube-system", "stuck-agent", 0),
      ],
    });

    const manifest = await buildKubernetesManifest();

    expect(manifest.services.map((s) => s.status)).toEqual([
      "running",
      "stopped",
    ]);
  });

  // An unreachable API server is a failure to report, not a reason to advertise
  // nothing and go looking for something else to be.
  it("propagates an unreachable API server instead of reporting an empty fleet", async () => {
    mockListDeployments.mockRejectedValue(new Error("no cluster"));
    await expect(buildKubernetesManifest()).rejects.toThrow(/no cluster/);
  });
});
