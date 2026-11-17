import type {
  DockerServiceEntry,
  KubernetesWorkloadEntry,
} from "./schemas/runner-protocol.js";

// What a runner is, decided at onboarding and stored on its row. A runner serves
// exactly one of these; it is never probed, and never negotiated at runtime.
export type Platform = "docker" | "kubernetes";

// A literal tuple, so a schema can take it directly rather than restating it.
export const PLATFORMS = [
  "docker",
  "kubernetes",
] as const satisfies readonly Platform[];

// No DB-only fields, unlike a RunnerRecord, and the platform discriminant is what
// lets a caller partition the fleet before matching.
interface FleetRunnerBase {
  runnerId: string;
  // The model-visible address, assigned when the token is issued and the first segment of every
  // target key this runner advertises.
  serverName: string;
  hostname: string;
  online: boolean;
  lastSeen: number;
}

export interface DockerFleetRunner extends FleetRunnerBase {
  platform: "docker";
  services: DockerServiceEntry[];
}

export interface KubernetesFleetRunner extends FleetRunnerBase {
  platform: "kubernetes";
  services: KubernetesWorkloadEntry[];
}

export type FleetRunner = DockerFleetRunner | KubernetesFleetRunner;

// The first segment of every target key, which the model copies verbatim into a
// call, so it is held to what reads unambiguously inside an address.
const SERVER_NAME = /^[A-Za-z0-9._-]+$/;

export function serverNameError(name: string): string | null {
  if (name.trim().length === 0) return "Server name is required";
  // The raw value, not the trimmed one: a trailing space that trims away reads
  // as accepted and then fails the moment a second word follows it.
  if (!SERVER_NAME.test(name)) {
    return "Server name may only use letters, numbers, dots, dashes and underscores";
  }
  return null;
}
