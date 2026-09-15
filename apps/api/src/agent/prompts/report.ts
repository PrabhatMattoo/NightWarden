import type {
  Finding,
  GatedCall,
  InvestigationRecord,
  SubmittedReport,
} from "@nightwarden/shared";
import {
  openCandidateIds,
  principalFindings,
  standingFindings,
} from "@nightwarden/shared";
import type { RecordGap } from "../report.js";

// Short on purpose: the tool description sits next to the decision, while this
// competes with a long context by turn fifteen.
export const REPORT = `

## Keeping the record

You keep a record as you work: the candidates you are weighing, and the findings that settle them.

Open the candidate explanations worth testing with OpenCandidates, at least two, together, so you weigh alternatives rather than settling on the first plausible cause. Each carries what you expect to see if it is true and what would prove it false.

Settle a candidate with a tool result you gather after opening it: the calls from your opening evidence gathering are what raised the candidate, and a result you get after opening it is what tests it. Record each one you settle with RecordFinding, naming the candidate in 'candidate', the verdict it earned, what the evidence showed, and the ids of the calls that showed it. A finding you ruled out is worth as much to the reader as one that held; a candidate you had no way to check is recorded as untestable.

The record is append-only, and every finding settles exactly one candidate. To state a new view of a candidate you have already settled, record another finding naming that same candidate: the newest finding about a candidate carries the verdict that stands, and the earlier finding stays on the record beneath it as superseded. If you could not work out the cause, record what you tested and say so; that is an honest and useful ending, and inventing a cause to avoid it is not.

Record what you settle as you settle it, while the results are still in front of you. The write-up turn arrives once every candidate you opened carries a finding: it offers one tool and nothing else, you write the report there, and you cannot add to your record from it.`;

// A distinct opening per gap kind, so the loop counts what it already spent on
// each by matching these words rather than a second tally.
export const EMPTY_RECORD_OPENING = "Your investigation record is empty.";
export const UNTESTED_CANDIDATES_OPENING =
  "You have candidates you have not settled.";
export const RECORD_CHECK_OPENING = "You have answered";

function sentenceFor(gap: RecordGap): string {
  switch (gap.kind) {
    case "empty_record":
      return `${EMPTY_RECORD_OPENING} Call RecordFinding for each candidate you opened, naming it in 'candidate', with the verdict it earned, so the record says what you settled, including what you ruled out. If you could not work out the cause, record what you tested and settle it as disproven or untestable; that is an honest ending, and inventing a cause to avoid it is not.`;
    case "untested_candidates": {
      const rows = gap.open.map((c) => `${c.id}  ${c.statement}`).join("\n");
      return `${UNTESTED_CANDIDATES_OPENING} Settle each of these with RecordFinding, naming it in 'candidate':\n${rows}\nA candidate a tool result settles takes the verdict that result earned. A candidate you have no way to check takes 'untestable', which is a complete answer. The write-up turn arrives once every one of them carries a finding.`;
    }
  }
}

// Asks for a recommendation rather than another attempt: repeating a write
// that did not work is the failure this gate exists to catch.
const RECOVERY_SENTENCE =
  "Nothing can confirm whether the condition that opened this investigation has recovered. Check it yourself if you have a way to, and say what the user should do in your recommendation. Do not repeat a write that has already run.";

export function recordCheck(callsSinceClaim: number): string {
  return `${RECORD_CHECK_OPENING} ${callsSinceClaim} tool calls since your last recorded finding. If any of what you have read has settled a candidate - including one you have ruled out - record it now with RecordFinding, while the results are still close to hand. If you are still narrowing and have settled nothing yet, carry on; this is a question, not an instruction.`;
}

// One gap at a time reaches here, so the message names only what remains.
export function recordGapsMessage(gaps: RecordGap[]): string {
  return gaps.map(sentenceFor).join(" ");
}

// Sent before the forced candidates turn: enough evidence is in hand to weigh
// explanations, so the run opens them before it looks further.
export const CANDIDATES_OPENING_MESSAGE =
  "You have gathered initial evidence. Open the candidate explanations worth testing now, together, each with what you expect to see if it is true and what would prove it false. Open at least two: one round of reads has answered, which is too early to be certain a single explanation is the only one worth testing, and a candidate you go on to disprove is worth recording because it stops the reader retracing it.";

// Stable opening for the frontier reminder, so a resumed run reads what it
// already stated off the record rather than restating it.
const FRONTIER_OPENING = "Still open:";

// Sent when the set of open candidates changes, so the ones still to test stay
// in view rather than being lost behind a long chain of reads.
export function frontierMessage(record: InvestigationRecord): string {
  const byId = new Map(record.candidates.map((c) => [c.id, c]));
  const rows = openCandidateIds(record).flatMap((id) => {
    const c = byId.get(id);
    return c === undefined
      ? []
      : [`${c.id}  ${c.statement}  expect if true: ${c.ifTrue}`];
  });
  return `${FRONTIER_OPENING}\n${rows.join("\n")}\nTest one of these before you finish.`;
}

// Stable opening for the falsification turn, matched to count whether it has run.
export const FALSIFICATION_OPENING =
  "Before you finish, test your own conclusions.";

// The last look before the report: every candidate, its verdict, and what the
// model itself said would prove it false, generated from the record so it cannot drift.
export function falsificationMessage(record: InvestigationRecord): string {
  const verdictOf = new Map(
    standingFindings(record.findings).map((f) => [f.candidate, f.verdict]),
  );
  const rows = record.candidates.map(
    (c) =>
      `${c.id}  ${c.statement}  [${verdictOf.get(c.id) ?? "open"}]  would disprove: ${c.ifFalse}`,
  );
  const standing = principalFindings(record.findings);
  const close =
    standing.length === 0
      ? "You have not established a cause. If there is a candidate you have not tried, open it and test it. Otherwise, state plainly that you could not establish a cause and finish."
      : "Test what you said would disprove each finding that still stands, if you have not. If something breaks a finding, record another finding naming that same candidate: your new verdict stands and the earlier finding stays on the record beneath it as superseded. If nothing changes your conclusions, finish.";
  const table =
    rows.length === 0
      ? "You opened no candidates."
      : `Below is every candidate you opened.\n\n${rows.join("\n")}`;
  return `${FALSIFICATION_OPENING} ${table}\n\n${close}`;
}

function findingLine(f: Finding, indent: string): string {
  const cites =
    f.evidenceIds.length > 0
      ? f.evidenceIds.join(", ")
      : "nothing that resolved";
  return `${indent}${f.id} [${f.verdict}] ${f.statement}\n${indent}    ${f.explanation}\n${indent}    cites: ${cites}`;
}

/* Grouped by candidate, standing verdict first: a flat list invites a write-up
   that names one candidate's cause once per finding recorded about it. */
function findingsByCandidate(findings: Finding[]): string {
  const standing = new Set(standingFindings(findings).map((f) => f.id));
  const order = [...new Set(findings.map((f) => f.candidate))];
  return order
    .map((candidate) => {
      const mine = findings.filter((f) => f.candidate === candidate);
      const now = mine.filter((f) => standing.has(f.id));
      const before = mine.filter((f) => !standing.has(f.id));
      const lines = now.map((f) => findingLine(f, ""));
      if (before.length > 0) {
        lines.push(
          `    superseded, and still on the record:`,
          ...before.map((f) => findingLine(f, "    ")),
        );
      }
      return `${candidate}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function writeLine(call: GatedCall): string {
  const target = call.target === null ? "" : ` ${call.target}`;
  return `${call.at}  ${call.toolName}${target}  ${call.decision}`;
}

/* The findings and the ruled-out candidates render beneath what the model writes,
   so the rubric asks for the prose they have nowhere else to put. */
const REPORT_RUBRIC = `The findings and the candidates you ruled out are rendered beneath what you write, so do not restate them. Write, for the person reading this in the morning:

- summary: what broke and why, in a few sentences they can read in ten seconds.
- timeline: the moments that mattered, each with the evidence id behind it.
- impact: who was affected and for how long.
- recommendation: the one action to take now, or that none is needed.

"None found" is a complete and honest answer to any line; never invent one to fill it.`;

// Labelled, because a model shown an unattributed report cannot tell whose
// words it is reading, and revising your own work is the point.
function previousReportBlock(previous: SubmittedReport): string {
  const lines = [
    previous.headline === undefined ? null : `headline: ${previous.headline}`,
    previous.affected === undefined ? null : `affected: ${previous.affected}`,
    `summary: ${previous.summary}`,
    `timeline: ${previous.timeline.length} ${previous.timeline.length === 1 ? "entry" : "entries"}`,
    previous.impact === "" ? null : `impact: ${previous.impact}`,
    previous.recommendation === ""
      ? null
      : `recommendation: ${previous.recommendation}`,
  ].filter((line): line is string => line !== null);
  return `<previous-report written="${previous.submittedAt}">
You wrote this at the end of your last run on this investigation. Revise it in
light of what you have since learned: keep what still holds, change what does
not, and do not start from nothing. What you submit replaces it entirely, so
anything you leave out is lost.

${lines.join("\n")}
</previous-report>`;
}

// Repeated here rather than left to context: the timeline copies these handles
// verbatim, and turn forty is a bad place to copy one from.
export function reportRequest(
  findings: Finding[],
  writes: GatedCall[],
  unrecovered: boolean,
  previous: SubmittedReport | null = null,
): string {
  // A run that reached here with nothing recorded exhausted the gate's requests.
  // Saying so beats printing an empty heading it might write around.
  const recorded =
    findings.length === 0
      ? "RECORDED FINDINGS\nnone. Say plainly that no cause was established."
      : `RECORDED FINDINGS, by the candidate each settles\n${findingsByCandidate(findings)}`;
  const sections = [
    previous === null
      ? "Your investigation is over. Write it up for the user who will read it in the morning."
      : "This investigation has gone further since you last wrote it up. Write it up again, for the user who will read it in the morning.",
    recorded,
  ];
  if (previous !== null) sections.push(previousReportBlock(previous));
  if (writes.length > 0) {
    sections.push(`RELEASED WRITES\n${writes.map(writeLine).join("\n")}`);
  }
  if (unrecovered) sections.push(RECOVERY_SENTENCE);
  sections.push(REPORT_RUBRIC);
  sections.push(
    "Call ComposeReport once. The findings above are rendered beneath what you write, so write only the summary, the timeline, the impact and the recommendation.",
  );
  return sections.join("\n\n");
}

// The report turn came back wrong. One sentence naming what to fix, and the
// same tool offered again - there is nothing else it can do from here.
export function reportRetry(problem: string): string {
  return `${problem} Call ComposeReport again.`;
}
