import type {
  Finding,
  InvestigationRecord,
  SessionKind,
  SessionListPage,
  InvestigationStatus,
  StatusFilter,
} from "@nightwarden/shared";
import { FILTER_STATUSES, principalFindings } from "@nightwarden/shared";
import {
  countInvestigations,
  listSessionFacts,
  type SessionListFacts,
} from "./store.js";

const WAITING_ON: Record<
  NonNullable<SessionListFacts["pendingKind"]>,
  string
> = {
  approval: "Waiting on approval",
  clarification: "Waiting on an answer",
  continue: "Waiting to continue",
};

function leadingClaim(record: InvestigationRecord | null): Finding | null {
  return principalFindings(record?.findings ?? [])[0] ?? null;
}

// A finding's claim is the candidate it settles, so the line a person reads is
// looked up there rather than stored twice.
function claimOf(
  record: InvestigationRecord | null,
  finding: Finding | null | undefined,
): string | null {
  if (record === null || finding === undefined || finding === null) return null;
  return (
    record.candidates.find((c) => c.id === finding.candidate)?.statement ?? null
  );
}

// What a finished run left the user, in descending order of use: what to do,
// what it concluded, or what it ruled out so nobody repeats the work.
function whatItLeft(record: InvestigationRecord | null): string | null {
  const written = record?.report?.recommendation.trim();
  if (written) return written;
  const leading = claimOf(record, leadingClaim(record));
  if (leading !== null) return leading;
  const ruledOut = record?.findings
    .filter((f) => f.verdict === "disproven")
    .at(-1);
  const dismissed = claimOf(record, ruledOut);
  return dismissed === null ? null : `Ruled out: ${dismissed}`;
}

// Every branch is the system's record or the model's prose, so the failure
// mode is an empty line rather than a wrong one.
function deriveStatusLine(
  facts: SessionListFacts,
  status: InvestigationStatus | null,
): string | null {
  switch (status) {
    case "action_required":
      return facts.pendingKind !== null ? WAITING_ON[facts.pendingKind] : null;
    case "running":
    // What it had settled on when the person ended it, if it had settled on
    // anything. The run stopped; the claims it made before that still stand.
    case "stopped":
      return claimOf(facts.record, leadingClaim(facts.record));
    case "resolved":
      return "Alert condition recovered";
    case "completed":
      return whatItLeft(facts.record);
    case "failed":
      return facts.lastContent;
    case "not_started":
      return facts.heldReason;
    default:
      return null;
  }
}

export async function listSessionPage(
  limit: number,
  offset: number,
  kind: SessionKind,
  filter: { status?: StatusFilter; q?: string } = {},
): Promise<SessionListPage> {
  const { facts, nextOffset } = await listSessionFacts(limit, offset, kind, {
    ...(filter.status !== undefined && {
      statuses: FILTER_STATUSES[filter.status],
    }),
    ...(filter.q !== undefined &&
      filter.q !== "" && { titleContains: filter.q }),
  });
  return {
    rows: facts.map((row) => {
      const { investigation } = row;
      // A chat has no status to show, so the column it carries is not passed on.
      const status = investigation ? row.status : null;
      return {
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        lastActivityAt: row.lastActivityAt,
        title: row.title,
        investigation,
        severityLabel: row.alerts[0]?.alert.labels["severity"] ?? null,
        status,
        statusLine: investigation ? deriveStatusLine(row, status) : null,
        awaitingHumanInput: row.awaitingHumanInput,
      };
    }),
    nextOffset,
    investigationTotal: await countInvestigations(),
  };
}
