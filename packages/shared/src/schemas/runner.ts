import { z } from "zod";
import { PLATFORMS } from "../runner.js";
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
