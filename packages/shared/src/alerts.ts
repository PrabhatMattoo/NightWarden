// One row per kind, so a user sees one card and one credential each. The kind
// decides which card, never how a body is parsed.
export const ALERT_SOURCE_KINDS = ["alertmanager", "grafana"] as const;

export type AlertSourceKind = (typeof ALERT_SOURCE_KINDS)[number];

export function isAlertSourceKind(value: string): value is AlertSourceKind {
  return ALERT_SOURCE_KINDS.some((kind) => kind === value);
}
