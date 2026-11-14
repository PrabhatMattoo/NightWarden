// Two unrelated identities, not two arms of one union. A Docker runner can only
// ever hold the first and a Kubernetes runner only the second, so nothing narrows.

import type { z } from "zod";
import type {
  dockerServiceIdentitySchema,
  k8sWorkloadKindSchema,
  kubernetesWorkloadIdentitySchema,
} from "./schemas/service-identity.js";

export type DockerServiceIdentity = z.infer<typeof dockerServiceIdentitySchema>;
export type KubernetesWorkloadIdentity = z.infer<
  typeof kubernetesWorkloadIdentitySchema
>;
export type K8sWorkloadKind = z.infer<typeof k8sWorkloadKindSchema>;

// Docker sets the dotted form, and cAdvisor and Prometheus each re-render the
// same two labels their own way, so all three spellings are read.
export function composeServiceLabels(
  labels: Record<string, string | undefined> | undefined,
): { project: string; service: string } | null {
  const project = composeLabel(labels, "project");
  const service = composeLabel(labels, "service");
  return project !== undefined && service !== undefined
    ? { project, service }
    : null;
}

// Compose re-stamps the project/service labels on every recreate, so they outlive the container
// name/ID across a redeploy; anonymous `docker run` falls back to the live name.
export function deriveDockerServiceIdentity(
  labels: Record<string, string | undefined> | undefined,
  liveName: string,
): DockerServiceIdentity {
  return (
    composeServiceLabels(labels) ?? { project: liveName, service: liveName }
  );
}

function composeLabel(
  labels: Record<string, string | undefined> | undefined,
  field: "project" | "service",
): string | undefined {
  return (
    labels?.[`com.docker.compose.${field}`] ??
    labels?.[`compose_${field}`] ??
    labels?.[`container_label_com_docker_compose_${field}`]
  );
}

// Where it lives, its scope, its name. The server segment is what makes one key
// mean one thing on a fleet where two machines run the same service.
export function dockerServiceKey(
  server: string,
  id: DockerServiceIdentity,
): string {
  return `${server}/${id.project}/${id.service}`;
}

export function kubernetesWorkloadKey(
  server: string,
  id: KubernetesWorkloadIdentity,
): string {
  return `${server}/${id.namespace}/${id.workload}`;
}

export interface ParsedTargetKey {
  server: string;
  scope: string;
  name: string;
}

// Null for anything that is not three non-empty segments, which is how a key the
// model assembled itself is caught before it routes anywhere.
export function parseTargetKey(target: string): ParsedTargetKey | null {
  const [server, scope, name, ...rest] = target.split("/");
  if (rest.length > 0) return null;
  if (!server || !scope || !name) return null;
  return { server, scope, name };
}
