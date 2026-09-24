import type { Platform, RunnerRecord } from "@nightwarden/shared";

// Connected once it has reported a host, on the platform its row names from onboarding.
export function connectedOn(
  runners: readonly RunnerRecord[],
  platform: Platform,
): RunnerRecord[] {
  return runners.filter((r) => r.hostname !== null && r.platform === platform);
}
