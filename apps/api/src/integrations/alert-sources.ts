import { hashToken, issueToken, tokenMatches } from "../secrets.js";
import {
  allIntegrations,
  deleteIntegrationsOfKind,
  integrationOfKind,
  putIntegration,
  touchIntegration,
  type IntegrationRow,
} from "./store.js";
import { isAlertSourceKind } from "@nightwarden/shared";
import type { AlertSourceKind } from "@nightwarden/shared";

// The one connection whose credential we verify rather than present, so the
// only kind filling `token_hash`. The plaintext is shown once when it is issued.

interface AlertSourceRow {
  kind: string;
  lastReceivedAt: string | null;
  createdAt: string;
}

function isAlertSourceRow(row: IntegrationRow): boolean {
  return isAlertSourceKind(row.kind);
}

export function getAlertSource(kind: AlertSourceKind): AlertSourceRow | null {
  const row = integrationOfKind(kind);
  if (row === null) return null;
  return {
    kind: row.kind,
    lastReceivedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/* Rotation resets the delivery stamp: deliveries made with the previous
   credential prove nothing about the new one, so status regresses to waiting. */
export function generateAlertSourceToken(kind: AlertSourceKind): string {
  const plaintext = issueToken("nwi");
  const existing = integrationOfKind(kind);
  putIntegration(
    {
      kind,
      name:
        kind === "alertmanager"
          ? "Prometheus Alertmanager"
          : "Grafana Alerting",
      config: {},
      tokenHash: hashToken(plaintext),
      lastUsedAt: null,
    },
    existing?.id,
  );
  return plaintext;
}

export function setAlertSourceReceived(kind: string, receivedAt: string): void {
  const row = integrationOfKind(kind);
  if (row !== null) touchIntegration(row.id, receivedAt);
}

export function deleteAlertSource(kind: AlertSourceKind): void {
  deleteIntegrationsOfKind(kind);
}

/* Compared in constant time against every sender rather than looked up by
   index, because an indexed lookup on a secret leaks timing. */
export function findAlertSourceKindByToken(plaintext: string): string | null {
  for (const row of allIntegrations()) {
    if (!isAlertSourceRow(row) || row.tokenHash === null) continue;
    if (tokenMatches(plaintext, row.tokenHash)) return row.kind;
  }
  return null;
}
