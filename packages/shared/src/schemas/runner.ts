import { z } from "zod";
import { PLATFORMS, serverNameError } from "../runner.js";
import { runnerManifestSchema } from "./runner-protocol.js";

// One row per live connection, or one offline row per token so its install
// command stays discoverable.
const runnerRecordSchema = z.object({
  id: z.string(),
  platform: z.enum(PLATFORMS),
  serverName: z.string(),
  hostname: z.string().nullable(),
  createdAt: z.string(),
  online: z.boolean(),
  lastSeen: z.string().nullable(),
  manifest: runnerManifestSchema.nullable(),
});
export type RunnerRecord = z.infer<typeof runnerRecordSchema>;

export const runnerRecordsSchema = z.array(runnerRecordSchema);

// The form checks with the same function, so the page and the API never disagree.
export const createRunnerRequestSchema = z.object({
  platform: z.enum(PLATFORMS),
  serverName: z.string().superRefine((name, ctx) => {
    const error = serverNameError(name);
    if (error !== null) ctx.addIssue({ code: "custom", message: error });
  }),
});
export type CreateRunnerRequest = z.infer<typeof createRunnerRequestSchema>;

// The plaintext nwr_... token is returned exactly once, here, and never stored.
export const createdRunnerSchema = z.object({
  id: z.string(),
  token: z.string(),
  platform: z.enum(PLATFORMS),
  serverName: z.string(),
  createdAt: z.string(),
});
export type CreatedRunner = z.infer<typeof createdRunnerSchema>;
