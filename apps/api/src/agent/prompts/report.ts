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
import type { OpenCandidate, RecordGap } from "../report.js";

// Short on purpose: the tool description sits next to the decision, while this
// competes with a long context by turn fifteen.
export const REPORT = `

## Keeping the record

You keep a record as you work: the candidates you are weighing, and the findings that settle them.

Open the candidate explanations worth testing with OpenCandidates, at least two, together, so you weigh alternatives rather than settling on the first plausible cause. Each carries what you expect to see if it is true and what would prove it false.

Settle a candidate with a tool result you gather after opening it: the calls from your opening evidence gathering are what raised the candidate, and a result you get after opening it is what tests it. Record each one you settle with RecordFinding, naming the candidate in 'candidate', the verdict it earned, what the evidence showed, and the ids of the calls that showed it. A finding you ruled out is worth as much to the reader as one that held; a candidate you had no way to check is recorded as untestable.

The record is append-only, and every finding settles exactly one candidate. To state a new view of a candidate you have already settled, record another finding naming that same candidate: the newest finding about a candidate carries the verdict that stands, and the earlier finding stays on the record beneath it as superseded. If you could not work out the cause, record what you tested and say so; that is an honest and useful ending, and inventing a cause to avoid it is not.

Record what you settle as you settle it, while the results are still in front of you. When every candidate you opened carries a finding, call CloseInvestigation. You are then asked to test your own conclusions once, and after that to write the report, which gets a turn of its own with one tool on it and nothing else.`;

// One per gap kind, each the fixed part of its message: the loop counts what it
// already spent on that gap by matching these words rather than a second tally.
export const EMPTY_RECORD_MESSAGE = "Your investigation record is empty.";
export const UNTESTED_CANDIDATES_MESSAGE =
  "You have candidates you have not settled.";
export const RECORD_CHECK_MESSAGE = "You have answered";

function sentenceFor(gap: RecordGap): string {
  switch (gap.kind) {
    case "empty_record":
      return `${EMPTY_RECORD_MESSAGE} Call RecordFinding for each candidate you opened, naming it in 'candidate', with the verdict it earned, so the record says what you settled, including what you ruled out. If you could not work out the cause, record what you tested and settle it as disproven or untestable; that is an honest ending, and inventing a cause to avoid it is not.`;
    case "untested_candidates": {
      const rows = gap.open.map((c) => `${c.id}  ${c.statement}`).join("\n");
      return `${UNTESTED_CANDIDATES_MESSAGE} Settle each of these with RecordFinding, naming it in 'candidate':\n${rows}\nA candidate a tool result settles takes the verdict that result earned. A candidate you have no way to check takes 'untestable', which is a complete answer. Once every candidate carries a finding, the harness asks you to test your own conclusions, and CloseInvestigation is offered from there.`;
    }
  }
}

// Asks for a recommendation rather than another attempt: repeating a write
// that did not work is the failure this gate exists to catch.
const RECOVERY_SENTENCE =
  "Nothing can confirm whether the condition that opened this investigation has recovered. Check it yourself if you have a way to, and say what the user should do in your recommendation. Do not repeat a write that has already run.";

export function recordCheck(callsSinceClaim: number): string {
  return `${RECORD_CHECK_MESSAGE} ${callsSinceClaim} tool calls since your last recorded finding. If any of what you have read has settled a candidate - including one you have ruled out - record it now with RecordFinding, while the results are still close to hand. If you are still narrowing and have settled nothing yet, carry on; this is a question, not an instruction.`;
}

// One gap at a time reaches here, so the message names only what remains.
export function recordGapsMessage(gaps: RecordGap[]): string {
  return gaps.map(sentenceFor).join(" ");
}

// Sent once at the start of the opening stage: the reads have answered, so the
// run commits to its explanations before it looks for the evidence that tests them.
export const CANDIDATES_OPENING_MESSAGE =
  "The reads you requested have finished. Open your candidates now with OpenCandidates: at least two candidates, in one call. For each candidate, state what you expect to see if the candidate is true, and what result would prove the candidate false. You can open more candidates later, during testing.";

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
  return `Still open:\n${rows.join("\n")}\nTest one of these before you finish.`;
}

/* The fixed opening of every no-tool nudge, so the allowance counts one pattern
   across its stage-specific wordings rather than four. */
export const TEXT_ONLY_PREFIX =
  "Your last reply called no tool, so the investigation did not move forward.";

/* What a no-tool reply is told depends on where the investigation stands, since
   the next move is the stage's own. */
export function textOnlyReplyMessage(
  stage: "opening" | "testing" | "falsifying" | "writingReport",
  open: readonly OpenCandidate[],
): string {
  switch (stage) {
    case "opening":
      return `${TEXT_ONLY_PREFIX} Open your candidates now with OpenCandidates: at least two candidates, in one call.`;
    case "testing":
      return open.length === 0
        ? `${TEXT_ONLY_PREFIX} Open new candidates with OpenCandidates, or record a finding for an existing candidate with RecordFinding.`
        : `${TEXT_ONLY_PREFIX} These candidates do not have a finding yet:\n${open.map((c) => `${c.id}  ${c.statement}`).join("\n")}\nTest each candidate with a read, then record the outcome with RecordFinding.`;
    case "falsifying":
      return `${TEXT_ONLY_PREFIX} Run the next read that could disprove a finding, or call CloseInvestigation if no further read would change any finding.`;
    case "writingReport":
      return `${TEXT_ONLY_PREFIX} Write the report now with ComposeReport.`;
  }
}

// The fixed part of the falsification message, matched to count whether it ran.
export const FALSIFICATION_MESSAGE =
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
      ? "No finding established a cause. If a possible explanation is still untested, open that explanation as a candidate and test the candidate. Otherwise, call CloseInvestigation, and state in the report that no cause was found."
      : "For each finding that stands, run the read that would prove that finding false, unless you have already run that read. If a read breaks a finding, record a new finding for that candidate: your new verdict stands and the earlier finding stays on the record beneath it as superseded. If you open a new candidate, test the new candidate and record a finding for it before you finish. When no further read would change any finding, call CloseInvestigation.";
  const table =
    rows.length === 0
      ? "You opened no candidates."
      : `Below is every candidate you opened.\n\n${rows.join("\n")}`;
  return `${FALSIFICATION_MESSAGE} ${table}\n\n${close}`;
}

/* The verdict and the handles, not the prose: the write-up renders beneath these
   findings, and repeating their words here is what invites it to copy them. */
function findingLine(f: Finding, indent: string): string {
  const cites =
    f.evidenceIds.length > 0
      ? f.evidenceIds.join(", ")
      : "nothing that resolved";
  return `${indent}${f.id} [${f.verdict}] cites: ${cites}`;
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

/* The fixed part of the write-up request, matched to count the attempts a run
   has already made at its report. */
export const REPORT_REQUEST_MESSAGE = "Your investigation is over.";

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
      ? `${REPORT_REQUEST_MESSAGE} Write the report for the user who will read it in the morning.`
      : `${REPORT_REQUEST_MESSAGE} The investigation has gone further since your last report, so write the report again.`,
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

/* The fixed part of the closing message, matched to count whether the run has
   already spoken: the closing phase is reached once and never returned to. */
export const CLOSING_MESSAGE =
  "Your report is written and is on screen for the person now.";

/* The one turn the reader is addressed in, run after the report with no tools
   offered, so the words they read are written knowing what the report holds. */
export function closingMessage(record: InvestigationRecord): string {
  const ruledOut = record.findings.filter(
    (f) => f.verdict === "disproven" || f.verdict === "untestable",
  ).length;
  const leading = principalFindings(record.findings)[0];
  const cause =
    leading === undefined
      ? "It says no cause was established."
      : `It leads with a ${leading.verdict.replace("_", " ")}.`;
  const dismissed =
    ruledOut === 0
      ? ""
      : ` It also lists ${ruledOut === 1 ? "the candidate" : `the ${ruledOut} candidates`} you ruled out.`;
  return `${CLOSING_MESSAGE} ${cause}${dismissed} Write the closing message to them, in 2 to 4 sentences, in your own words rather than copying a sentence out of the report.

Say where the report is and name which of its sections carry substance. Then close on what the person does next: where your recommendation names an action you can carry out, name the action and ask whether to proceed with it; where the investigation established no cause, name the one observation that would settle the question; where the alert has already cleared, say so.`;
}

/* A later attempt at the write-up. The refusal is already on the transcript in
   the tool's own words, so this says what to do rather than repeating why. */
export const REPORT_RETRY_MESSAGE =
  "Your last ComposeReport call did not land. Read what it answered, correct the arguments it named, and call ComposeReport again.";

/* The fixed part of the reopen turn, which the stage derivation also reads: a
   row carrying it starts the reopened investigation's own epoch. */
export const REOPEN_PREFIX = "The user reopened this investigation";

// The opening turn of a reopened investigation, written the way an alert's is:
// as the harness's own row, before any turn the model takes.
export const REOPEN_MESSAGE = `${REOPEN_PREFIX}, and every earlier candidate and finding is still on the record. Open new candidates for what the new evidence suggests, or record new findings for existing candidates, with RecordFinding. For each candidate you open, state what you expect to see if the candidate is true, and what result would prove the candidate false.`;
