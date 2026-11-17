// One client, no per-product adapter: what differs is where the rules live,
// how the credential is presented, and what the source cannot answer.

export const METRICS_SOURCE_KINDS = [
  "prometheus",
  "victoriametrics",
  "mimir",
  "thanos",
  "amp",
] as const;

export type MetricsSourceKind = (typeof METRICS_SOURCE_KINDS)[number];

export function isMetricsSourceKind(value: string): value is MetricsSourceKind {
  return METRICS_SOURCE_KINDS.some((kind) => kind === value);
}

// AMP signs every request with these instead of a static header.
export interface AmpCredential {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}
