// Three parts, three authors, three moments: the candidates the agent opens as
// it reasons, the findings it appends as it settles them, and the report at the end.

import type {
  Finding,
  InvestigationRecord,
  Verdict,
  Candidate,
} from "./schemas/report.js";

// What a refused close can name as missing: no finding at all, or a candidate
// still carrying none.
export type RecordGapKind = "empty_record" | "untested_candidates";

// Most confident first. `disproven` and `untestable` sort last and never lead:
// one is what the run ruled out, the other what it could not reach.
const VERDICT_ORDER: readonly Verdict[] = [
  "root_cause",
  "trigger",
  "contributing_factor",
  "symptom",
  "disproven",
  "untestable",
];

/* One ordering, so the queue row and the report cannot name different leading
   findings. Equal confidence breaks newest first, after the most work. */
export function rankFindings(findings: Finding[]): Finding[] {
  return findings
    .map((finding, recorded) => ({ finding, recorded }))
    .sort(
      (a, b) =>
        VERDICT_ORDER.indexOf(a.finding.verdict) -
          VERDICT_ORDER.indexOf(b.finding.verdict) || b.recorded - a.recorded,
    )
    .map(({ finding }) => finding);
}

/* A finding's claim is its candidate's: the sentence is stored once, where it
   was opened. The id stands in where a record has lost the candidate. */
export function claimOf(
  candidates: Candidate[],
  finding: Pick<Finding, "candidate">,
): string {
  return (
    candidates.find((c) => c.id === finding.candidate)?.statement ??
    finding.candidate
  );
}

// The candidates no finding speaks for. Every finding settles exactly one, so a
// candidate is open until one names it.
export function openCandidateIds(record: InvestigationRecord): string[] {
  const settled = new Set(record.findings.map((f) => f.candidate));
  return record.candidates.filter((c) => !settled.has(c.id)).map((c) => c.id);
}

// The finding that carries each candidate's verdict: the last one recorded about
// it, since the record is append-only and a later call states the current view.
export function standingFindings(findings: Finding[]): Finding[] {
  const latest = new Map<string, Finding>();
  for (const finding of findings) latest.set(finding.candidate, finding);
  return [...latest.values()];
}

// Every finding a later one about the same candidate now speaks for. They stay on
// the record and stay rendered; what they lose is the ability to lead.
export function supersededIds(findings: Finding[]): Set<string> {
  const standing = new Set(standingFindings(findings).map((f) => f.id));
  return new Set(findings.filter((f) => !standing.has(f.id)).map((f) => f.id));
}

// One finding per candidate at the best verdict rank present, so a multi-factor
// cause keeps each factor and a candidate speaks once.
export function principalFindings(findings: Finding[]): Finding[] {
  const standing = rankFindings(standingFindings(findings)).filter(
    (f) => f.verdict !== "disproven" && f.verdict !== "untestable",
  );
  const top = standing[0];
  return top === undefined
    ? []
    : standing.filter((f) => f.verdict === top.verdict);
}
