// Every message between the API and a runner. Both ends parse on arrival, since
// each side's sender is the other process and nothing past the socket is trusted.

import { z } from "zod";
import {
  dockerServiceIdentitySchema,
  k8sWorkloadKindSchema,
  kubernetesWorkloadIdentitySchema,
} from "./service-identity.js";

const serviceEntryBase = { target: z.string(), status: z.string() };

const dockerServiceEntrySchema = z.object({
  ...serviceEntryBase,
  identity: dockerServiceIdentitySchema,
});

const kubernetesWorkloadEntrySchema = z.object({
  ...serviceEntryBase,
  identity: kubernetesWorkloadIdentitySchema,
  // Required, unlike the Docker entry: the pod-name rules that resolve an alert need it.
  kind: k8sWorkloadKindSchema,
});

const manifestBase = { hostname: z.string(), runnerVersion: z.string() };

// platform is also the mismatch check: the API compares it against the runner's row.
export const runnerManifestSchema = z.discriminatedUnion("platform", [
  z.object({
    ...manifestBase,
    platform: z.literal("docker"),
    services: z.array(dockerServiceEntrySchema),
  }),
  z.object({
    ...manifestBase,
    platform: z.literal("kubernetes"),
    services: z.array(kubernetesWorkloadEntrySchema),
  }),
]);

const envelope = { messageId: z.string() };

export const runnerMessageSchema = z.discriminatedUnion("type", [
  // API to runner, carrying the deadline the API's own timer keeps.
  z.object({
    ...envelope,
    type: z.literal("command"),
    payload: z.object({
      commandName: z.string(),
      commandInput: z.record(z.string(), z.unknown()),
      correlationId: z.string(),
      timeoutMs: z.number().int().positive(),
    }),
  }),
  // API to runner: the token was accepted.
  z.object({
    ...envelope,
    type: z.literal("connected"),
    payload: z.object({}),
  }),
  // API to runner: the name every target key in the manifest is prefixed with.
  z.object({
    ...envelope,
    type: z.literal("identity"),
    payload: z.object({ serverName: z.string() }),
  }),
  // API to runner: the API's own container, which the runner keeps out of every list.
  z.object({
    ...envelope,
    type: z.literal("hide_container"),
    payload: z.object({ containerId: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal("manifest"),
    payload: runnerManifestSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal("result"),
    payload: z.object({
      correlationId: z.string(),
      success: z.boolean(),
      result: z.unknown(),
      error: z.string().optional(),
    }),
  }),
]);

export type RunnerMessage = z.infer<typeof runnerMessageSchema>;
export type RunnerCommandMessage = Extract<RunnerMessage, { type: "command" }>;
export type RunnerConnectedMessage = Extract<
  RunnerMessage,
  { type: "connected" }
>;
export type RunnerIdentityMessage = Extract<
  RunnerMessage,
  { type: "identity" }
>;
export type HideContainerMessage = Extract<
  RunnerMessage,
  { type: "hide_container" }
>;
export type RunnerManifestMessage = Extract<
  RunnerMessage,
  { type: "manifest" }
>;
export type RunnerResultMessage = Extract<RunnerMessage, { type: "result" }>;
export type RunnerManifest = z.infer<typeof runnerManifestSchema>;
export type DockerManifest = Extract<RunnerManifest, { platform: "docker" }>;
export type KubernetesManifest = Extract<
  RunnerManifest,
  { platform: "kubernetes" }
>;
export type DockerServiceEntry = z.infer<typeof dockerServiceEntrySchema>;
export type KubernetesWorkloadEntry = z.infer<
  typeof kubernetesWorkloadEntrySchema
>;

// A frame's text to a checked message, or the reason it is not one.
export function parseRunnerMessage(
  text: string,
): { ok: true; message: RunnerMessage } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const parsed = runnerMessageSchema.safeParse(json);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, reason: z.prettifyError(parsed.error) };
}
