// Thin adapters over the report domain service. Which turn is offered which of
// them is the loop's business rather than the toolset's.

import { z } from "zod";
import {
  composeReport,
  openCandidates,
  recordFinding,
  type RecordOutcome,
} from "../report.js";
import { recordGaps } from "../report.js";
import { recordGapsMessage } from "../prompts/report.js";
import { apiTool, optionalText } from "./schema.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// Prose the record cannot do without. A blank one is the model skipping the
// field, which stores a row nobody can read.
const prose = z.string().trim().min(1);

// Three sentences of reasoning, and the ceiling the candidate board renders at.
const MAX_EXPLANATION_CHARS = 800;

const OPEN_CANDIDATES_INPUT = z.object({
  candidates: z
    .array(
      z.object({
        statement: prose.meta({
          description:
            "The explanation to test, stated so a tool result could settle it either way. Name the thing you mean: 'the retry loop in PR #482 exhausted the payments-api connection pool', not 'a database problem'.",
        }),
        ifTrue: prose.meta({
          description:
            "The observation you expect if this is true, written before you look. 'pool_in_use sits at its ceiling across the slowdown window.'",
        }),
        ifFalse: prose.meta({
          description:
            "The observation that would prove this false. 'pool_in_use has headroom throughout the slowdown.'",
        }),
        parent: optionalText.meta({
          description:
            "The id of the candidate this one explains, written c1, c2, when you are going a step deeper into a cause you already opened. Omit it for a candidate that stands on its own.",
        }),
      }),
    )
    .min(
      2,
      "open at least two candidates: one round of reads has answered, which is too early to be certain of a single explanation",
    )
    .meta({
      description:
        "The candidate explanations worth testing, opened together so you weigh them side by side rather than settling on the first. Open at least two: one round of reads has answered at this point, which is too early to be certain a single explanation is the only one worth testing. A candidate you open and then disprove is worth recording, because it stops the reader retracing it.",
    }),
});

// Reasoning before conclusion: the explanation sits ahead of the verdict, so the
// model commits to what the evidence showed before it grades the finding.
const RECORD_FINDING_INPUT = z.object({
  explanation: z
    .string()
    .max(
      MAX_EXPLANATION_CHARS,
      `an explanation may be at most ${MAX_EXPLANATION_CHARS} characters`,
    )
    .meta({
      description: `What the cited results showed, and why they settle this candidate the way your verdict says, at most ${MAX_EXPLANATION_CHARS} characters. Someone who was not here reads this under the candidate's own statement, so explain rather than remind: quote the value, the log line or the timestamp that decided it, and say what it means. Write between one and three complete sentences, and leave the candidate's statement out of it, since the reader already has it.`,
    }),
  evidenceIds: z.array(z.string()).meta({
    description:
      'The evidence ids of the tool calls whose results settle this candidate. A result that can back a claim opens with a line reading "Evidence ID: e1", and the handle is written e1, e2, e3 and so on. A tool that reads nothing about your system carries no evidence id and cannot be cited. Cite only calls whose results you have already read: a tool you ask for in this reply has not run yet, its result reaches you in your next message, and a finding citing it is refused. At least one id must come from a result you received after you opened this candidate, because that result is what tests the candidate; you may also cite results you received before opening it. If any id names no answered call, none of them is recorded. A finding with the verdict "untestable" may leave this empty, and any id an untestable finding does cite must come from an attempt you made after opening the candidate.',
  }),
  verdict: z
    .enum([
      "root_cause",
      "trigger",
      "symptom",
      "contributing_factor",
      "disproven",
      "untestable",
    ])
    .meta({
      description:
        "'root_cause' is the underlying condition that made the failure possible. 'trigger' is the event that set it off. 'symptom' is something the real cause produced downstream. 'contributing_factor' made the failure worse or more likely without causing it. 'disproven' means you tested it and it is not so. 'untestable' means you had no way to check it, which is different from disproving it. Most published analyses identify a trigger rather than a root cause, so do not reach for 'root_cause' when 'trigger' or 'symptom' is what the evidence shows.",
    }),
  candidate: z.string().meta({
    description:
      "The id of the candidate this finding settles, written c1, c2, as it was given back to you when you opened it. Every finding settles exactly one candidate. To state a new view of a candidate you have already settled, record another finding naming that same candidate: the newest finding about a candidate carries the verdict that stands, and the earlier finding stays on the record beneath it as superseded. To record something you learned about an explanation you have yet to open, open it with OpenCandidates first and settle it here.",
  }),
});

const COMPOSE_REPORT_INPUT = z.object({
  headline: prose.meta({
    description:
      "One sentence, under about 120 characters, naming what broke and why. This is the line someone reads at three in the morning before deciding whether to get up, and often the only line they read. State the cause, not the symptom: 'the retry loop added in PR #482 exhausted the payments-api connection pool', never 'payments-api returned errors'.",
  }),
  affected: prose.meta({
    description:
      "A short noun phrase naming who or what was hit, for the band at the top of the report: 'the checkout path', 'all payments-api pods in prod'. Not a sentence, and not a duplicate of the impact field below, which says for how long and how badly.",
  }),
  summary: prose.meta({
    description:
      "Two or three sentences expanding the headline: what broke, why, and where it stands now. Name the service, the value and the change.",
  }),
  timeline: z
    .array(
      z.object({
        at: z.iso.datetime({ offset: true }).meta({
          description:
            "When it happened, as an ISO 8601 timestamp carrying a timezone: 2026-01-14T03:12:45Z, or 2026-01-14T08:42:45+05:30. Copy it, to the second, from the result you cite in evidenceId; a time that does not appear in that result is refused. Never a guess.",
        }),
        what: prose.meta({
          description: "One sentence, in the past tense.",
        }),
        lane: z.enum(["change", "signal", "agent"]).optional().meta({
          description:
            "Which strand this moment belongs to. 'change' is something a human or a deploy did to the system: a merge, a rollout, a config edit. 'signal' is the system reacting: an alert firing, a metric crossing a threshold, a pod restarting. 'agent' is something you did while investigating. Writes you released are added for you and are not any of these.",
        }),
        evidenceId: prose.meta({
          description:
            "The evidence id of the tool call whose result carries this moment, written e1, e2, e3 as it appears on that result. The time in 'at' must appear in that same result.",
        }),
      }),
    )
    .meta({
      description:
        "What happened, earliest first. Include only moments that matter, each drawn from a result you read: the change that set it up, the failure, and anything you did about it. Every write you released is added for you, so do not list those.",
    }),
  impact: prose.meta({
    description:
      "Who or what was affected and for how long, in a sentence. If you cannot tell from what you read, say so plainly rather than estimating.",
  }),
  recommendation: prose.meta({
    description:
      "What the user should do, in the present or future tense, never as a claim that something has already been done: what you ran is recorded separately and shown to them. If a write you released already fixed it, say what would stop it recurring.",
  }),
});

// A refusal is the record holding its ground. It reads as an error because the
// submission did not land and the model has to correct it and try again.
function toResult(recording: RecordOutcome): ToolExecuteResult {
  return recording.recorded
    ? { content: recording.message }
    : { content: recording.message, isError: true };
}

export const REPORT_TOOLS: Tool[] = [
  apiTool({
    name: "OpenCandidates",
    description:
      "Open the candidate explanations worth testing, each with what you expect to see if it is true and what would prove it false. Open them together so you weigh alternatives side by side rather than settling on the first plausible cause. Opening a candidate observes nothing about your system, so a call to OpenCandidates carries no evidence id and no claim can cite it.",
    input: OPEN_CANDIDATES_INPUT,
    effect: "read",
    policy: "auto",
    citable: false,
    execute: async (input, ctx): Promise<ToolExecuteResult> =>
      toResult(await openCandidates(ctx.sessionId, input)),
  }),
  apiTool({
    name: "CloseInvestigation",
    description:
      "CloseInvestigation finishes the investigation and reaches the report stage, where you write the report with ComposeReport. It is offered only after the harness has asked you to test your own conclusions, so call it during falsification, when no further evidence would change any finding. The call is refused while any candidate carries no finding, and the refusal names each such candidate.",
    input: z.object({}),
    effect: "read",
    policy: "auto",
    citable: false,
    /* The gate the ending already answers to, asked here instead of at silence:
       a gap is the model's to close, so the refusal names it and the run goes on. */
    execute: async (_input, ctx): Promise<ToolExecuteResult> => {
      const gaps = await recordGaps(ctx.sessionId);
      return gaps.length === 0
        ? { content: "Accepted. Every candidate you opened carries a finding." }
        : {
            content: recordGapsMessage(gaps),
            isError: true,
            refusal: {
              kind: "record_gaps",
              gaps: gaps.map((gap) => gap.kind),
            },
          };
    },
  }),
  apiTool({
    name: "RecordFinding",
    description:
      "Record a candidate explanation you have tested, and what testing it showed. Call this each time you settle one, including the ones that turned out to be wrong: what you ruled out is what stops the user repeating your work at three in the morning. Name the candidate it settles in 'candidate'. The record is append-only, so a later finding about a candidate carries the verdict that stands and the earlier finding stays on the record beneath it as superseded. RecordFinding records a claim by citing the tool calls whose results show that claim. RecordFinding reads nothing about your system, so a call to RecordFinding carries no evidence id, and no claim can cite a call to RecordFinding.",
    input: RECORD_FINDING_INPUT,
    effect: "read",
    policy: "auto",
    citable: false,
    execute: async (input, ctx): Promise<ToolExecuteResult> =>
      toResult(await recordFinding(ctx.sessionId, input)),
  }),
];

/* Never in the toolset: offering it alongside the investigation tools would let
   a run write itself up in the middle of working. */
export const COMPOSE_REPORT_TOOL: Tool = apiTool({
  name: "ComposeReport",
  description:
    "Write up the investigation you have just finished, for the user who will read it in the morning. Your findings are already on the record and are rendered beneath what you write here, so do not restate them: no verdicts, no findings, no re-copied citations. Write the things the record has no room for.",
  input: COMPOSE_REPORT_INPUT,
  effect: "read",
  policy: "auto",
  citable: false,
  execute: async (input, ctx): Promise<ToolExecuteResult> => {
    const { headline, affected, summary, timeline, impact, recommendation } =
      input;
    return toResult(
      await composeReport(ctx.sessionId, {
        headline,
        affected,
        summary,
        timeline: timeline.map((entry) => ({
          at: entry.at,
          what: entry.what,
          ...(entry.lane !== undefined && { lane: entry.lane }),
          ...(entry.evidenceId !== undefined && {
            evidenceId: entry.evidenceId,
          }),
        })),
        impact,
        recommendation,
      }),
    );
  },
});
