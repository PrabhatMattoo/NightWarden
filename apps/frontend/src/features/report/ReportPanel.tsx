// Three axes, one meaning each: size is level, weight marks a heading alone,
// and colour says what a thing is rather than how loud.

import type {
  GatedCall,
  Finding,
  SessionAlert,
  InvestigationRecord,
  ResolvedEvidence,
  TimelineEntry,
  Verdict,
} from "@nightwarden/shared";
import {
  claimOf,
  principalFindings,
  rankFindings,
  supersededIds,
} from "@nightwarden/shared";
import { cn } from "@/shared/lib/utils";
import { StatusText, type StatusTone } from "@/shared/ui/status";
import { clock, elapsed, zoneName } from "@/shared/lib/time";
import { CitationChip } from "./CitationChip.js";
import { Evidence } from "./Evidence.js";

// Colour ranks a verdict: the root cause takes the accent, the other standing
// verdicts full ink, and a dismissed one grey.
const VERDICT_VIEW: Record<Verdict, { label: string; className: string }> = {
  root_cause: { label: "Root cause", className: "text-accent-ink" },
  trigger: { label: "Trigger", className: "text-ink-base" },
  contributing_factor: {
    label: "Contributing factor",
    className: "text-ink-base",
  },
  symptom: { label: "Symptom", className: "text-ink-base" },
  disproven: { label: "Disproven", className: "text-ink-muted" },
  untestable: { label: "Untestable", className: "text-ink-muted" },
};

const TIMELINE_ID = "report-timeline";

function BandHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return <h2 className="mb-3 type-heading">{children}</h2>;
}

// Space and a heading set a section apart, not a rule; the heading carries the
// break.
function Band({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mt-12">
      <BandHeading>{heading}</BandHeading>
      {children}
    </section>
  );
}

// Three words for the three outcomes worth telling apart: it ran, they said
// no, or it broke. Who decided is drawn beside the row, from `actor`.
function decisionView(call: {
  decision: "approved" | "rejected";
  isError?: boolean;
}): { label: string; tone: StatusTone } {
  if (call.decision === "rejected") return { label: "Declined", tone: "muted" };
  return call.isError === true
    ? { label: "Failed", tone: "fail" }
    : { label: "Ran", tone: "ok" };
}

// Read from the alerts themselves, not the opening message written for the
// model, so the first thing on screen at 02:14 is true.
function AlertBand({
  alerts,
}: {
  alerts: SessionAlert[];
}): React.JSX.Element | null {
  if (alerts.length === 0) return null;
  return (
    <section className="border-b-hairline border-edge pb-4">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {alerts.map(({ alert, clearedAt }) => (
          <li key={`${alert.sourceAlertId}-${alert.firedAt}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {/* The sender's own word, uncoloured. Ranking it here would show
                  a fleet labelling alerts P1 nothing at all. */}
              {alert.labels["severity"] !== undefined && (
                <span className="type-body text-ink-muted">
                  {alert.labels["severity"]}
                </span>
              )}
              <span className="type-heading">{alert.alertType}</span>
              <span className="ml-auto flex shrink-0 items-baseline gap-2 type-body">
                {clearedAt !== null && (
                  <span className="text-ok">Recovered</span>
                )}
                <span className="tabular-nums text-ink-muted">
                  {clock(clearedAt ?? alert.firedAt)}
                </span>
              </span>
            </div>
            <p className="m-0 mt-1 type-body text-ink-muted">
              {Object.entries(alert.labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "no labels"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Released writes are contributed here rather than listed by the model, so an
// action cannot be missing from a timeline it did not author.
type Row =
  | { kind: "event"; at: string; what: string }
  | { kind: "alert"; at: string }
  | {
      kind: "action";
      at: string;
      action: {
        toolName: string;
        target: string | null;
        decision: "approved" | "rejected";
        isError?: boolean;
        actor?: GatedCall["actor"];
      };
    };

function timelineRows(
  written: TimelineEntry[],
  decisions: GatedCall[],
  alertFiredAt: string | null = null,
): Row[] {
  const entries: Row[] = written.map((entry) => ({
    kind: "event" as const,
    at: entry.at,
    what: entry.what,
  }));
  const actions: Row[] = decisions.map((call) => ({
    kind: "action" as const,
    at: call.at,
    action: {
      toolName: call.toolName,
      target: call.target,
      decision: call.decision,
      ...(call.isError === true && { isError: true }),
      ...(call.actor !== undefined && { actor: call.actor }),
    },
  }));
  const alertRow: Row[] =
    alertFiredAt === null ? [] : [{ kind: "alert" as const, at: alertFiredAt }];
  return [...entries, ...actions, ...alertRow].sort((a, b) =>
    a.at.localeCompare(b.at),
  );
}

// Every row on one vertical spine: a time column, a connected node, and the narrative.
function TimelineRow({ row }: { row: Row }): React.JSX.Element {
  const isAlert = row.kind === "alert";

  return (
    <li className="group relative flex items-start gap-3">
      {/* Time column */}
      <span className="w-14 shrink-0 pt-1 text-right tabular-nums type-small text-ink-muted">
        {clock(row.at)}
      </span>

      {/* Node column with continuous vertical spine */}
      <div className="relative flex w-3 shrink-0 justify-center self-stretch">
        {/* Spine line connecting across all items */}
        <span
          aria-hidden
          className="absolute top-0 bottom-0 w-px bg-edge-strong group-first:top-2.5 group-last:bottom-auto group-last:h-2.5"
        />
        {/* Node dot */}
        <span
          aria-hidden
          className={cn(
            "mt-1.5 shrink-0 rounded-full ring-4 ring-ground",
            isAlert
              ? "h-2.5 w-2.5 bg-accent-ink"
              : row.kind === "action"
                ? "h-2 w-2 border-hairline border-ground bg-accent-ink/70"
                : "h-2 w-2 border-hairline border-ground bg-edge-strong",
          )}
        />
      </div>

      {/* Content column */}
      <div className="min-w-0 flex-1 pb-6 pt-1 type-body group-last:pb-0">
        {isAlert ? (
          <span className="emphasis text-ink-base">The alert fired</span>
        ) : row.kind === "event" ? (
          <span className="text-ink-base">{row.what}</span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-baseline gap-2">
            <StatusText tone={decisionView(row.action).tone}>
              {decisionView(row.action).label}
            </StatusText>
            <span className="font-mono type-body">
              {row.action.toolName}
              {row.action.target !== null && (
                <span className="text-ink-muted"> {row.action.target}</span>
              )}
            </span>
            {row.action.actor !== undefined && (
              <span className="shrink-0 type-small text-ink-muted">
                by {row.action.actor.name} ({row.action.actor.email})
              </span>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

// A sentence rather than a row of tiles, and a clause with no answer is left
// out rather than printed empty.
function Facts({
  record,
  evidence,
  decisions,
  span,
}: {
  record: InvestigationRecord;
  evidence: ResolvedEvidence[];
  decisions: GatedCall[];
  span: string | null;
}): React.JSX.Element | null {
  const leading = principalFindings(record.findings)[0] ?? null;
  const ruledOut = record.findings.filter(
    (f) => f.verdict === "disproven" || f.verdict === "untestable",
  );
  const approved = decisions.filter((call) => call.decision === "approved");

  const clauses: React.ReactNode[] = [];
  if (leading !== null) {
    clauses.push(
      <>
        Leading verdict{" "}
        <b className="emphasis text-ink-base">
          {VERDICT_VIEW[leading.verdict].label.toLowerCase()}
        </b>
      </>,
    );
  }
  if (record.findings.length > 0) {
    clauses.push(
      <>
        <b className="emphasis text-ink-base">{record.findings.length}</b>{" "}
        tested, <b className="emphasis text-ink-base">{ruledOut.length}</b>{" "}
        ruled out
      </>,
    );
  }
  if (evidence.length > 0) {
    clauses.push(
      <>
        <b className="emphasis text-ink-base">{evidence.length}</b> calls cited
      </>,
    );
  }
  if (approved.length > 0) {
    clauses.push(
      <>
        <b className="emphasis text-ink-base">{approved.length}</b>{" "}
        {approved.length === 1 ? "write" : "writes"} you approved
      </>,
    );
  }
  if (span !== null) {
    clauses.push(
      <>
        <b className="emphasis text-ink-base">{span}</b> end to end
      </>,
    );
  }
  if (clauses.length === 0) return null;

  return (
    <p className="m-0 mt-8 type-body text-ink-muted">
      {clauses.map((clause, at) => (
        <span key={at}>
          {at > 0 && " · "}
          {clause}
        </span>
      ))}
    </p>
  );
}

export function ReportPanel({
  record,
  decisions,
  evidence,
  alerts,
  createdAt = null,
  lastActivityAt = null,
}: {
  // Null until the agent records its first finding. The investigation view is
  // drawn from the session, not from this, so the panel outlives its absence.
  record: InvestigationRecord | null;
  // Every call the user had to release, and which way they went.
  decisions: GatedCall[];
  // The cited calls, resolved by the API against the transcript.
  evidence: ResolvedEvidence[];
  // In arrival order. The band shows them all; the evidence plots need just one
  // to draw the alert marker against.
  alerts: SessionAlert[];
  // What the run is timed between. Absent on a session still loading.
  createdAt?: string | null;
  lastActivityAt?: string | null;
}): React.JSX.Element {
  const alert = alerts[0]?.alert ?? null;
  const span =
    createdAt !== null && lastActivityAt !== null
      ? elapsed(createdAt, lastActivityAt)
      : null;

  /* A record exists once a candidate opens while every section is still empty,
     so the test is whether anything can be drawn, not whether a record is there. */
  const weighing = record?.candidates ?? [];
  if (
    record === null ||
    (record.findings.length === 0 && record.report === null)
  ) {
    return (
      <div className="report-column">
        <AlertBand alerts={alerts} />
        <h1 className="m-0 mt-8 type-title">Investigation</h1>
        <p className="m-0 mt-3 type-body text-ink-muted">
          {weighing.length === 0
            ? "The agent has not recorded a finding yet."
            : "The agent is testing these explanations. Nothing is settled yet."}
        </p>
        {weighing.length > 0 && (
          <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0">
            {weighing.map((candidate) => (
              <li
                key={candidate.id}
                className="grid grid-cols-key items-baseline gap-x-3 type-body"
              >
                <span className="font-mono type-small text-ink-muted">
                  {candidate.id}
                </span>
                <span>{candidate.statement}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const byId = new Map(evidence.map((e) => [e.evidenceId, e]));
  // Null until the run reaches its report turn, which reads as "not written
  // up yet" rather than as an empty write-up.
  const submitted = record.report ?? null;
  const ranked = rankFindings(record.findings);
  const replaced = supersededIds(record.findings);
  const dismissed = (v: Verdict): boolean =>
    v === "disproven" || v === "untestable";
  // Three homes: what the run backs, what it set aside, and what it overturned.
  const findings = ranked.filter(
    (h) => !dismissed(h.verdict) && !replaced.has(h.id),
  );
  const ruledOut = ranked.filter(
    (h) => dismissed(h.verdict) && !replaced.has(h.id),
  );
  const superseded = ranked.filter((h) => replaced.has(h.id));
  const rows = timelineRows(
    submitted?.timeline ?? [],
    decisions,
    alert?.firedAt ?? null,
  );
  const approved = decisions.filter((call) => call.decision === "approved");

  /* Drawn once per report: a second claim citing the same call names it and
     redraws nothing, because one measurement read twice reads as two. */
  const drawn = new Set<string>();
  const evidenceUnder = (ids: string[]): React.JSX.Element[] => {
    const cited = [...new Set(ids)]
      .flatMap((id) => byId.get(id) ?? [])
      .filter(
        (entry) =>
          entry.kind !== "logs" &&
          entry.kind !== "terminal" &&
          entry.kind !== "state" &&
          entry.kind !== "exception",
      );
    return cited.map((entry) => {
      const repeat = drawn.has(entry.toolCallId);
      drawn.add(entry.toolCallId);
      return (
        <Evidence
          key={entry.toolCallId}
          entry={entry}
          alert={alert}
          repeat={repeat}
        />
      );
    });
  };

  // Citations under a claim rendered as popping cobalt text links.
  const sourcesUnder = (ids: string[]): React.JSX.Element | null => {
    const cited = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
    if (cited.length === 0) return null;
    return (
      <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="type-small">Sources</span>
        {cited.map((entry) => (
          <CitationChip key={entry.toolCallId} evidence={entry} alert={alert} />
        ))}
      </div>
    );
  };

  // Verdict as a coloured heading, the claim beneath it. Demoted greys both and
  // draws no evidence: a superseded finding keeps its place, not its weight.
  const claim = (h: Finding, demoted = false): React.JSX.Element => (
    <li key={h.id}>
      <h4
        className={cn(
          "m-0 type-prose   ",
          demoted ? "text-ink-muted" : VERDICT_VIEW[h.verdict].className,
        )}
      >
        {VERDICT_VIEW[h.verdict].label}
      </h4>
      <p
        className={cn(
          "m-0 mt-1.5 type-prose  emphasis",
          demoted && "text-ink-muted",
        )}
      >
        {claimOf(record.candidates, h)}
      </p>
      {h.explanation && <p className="m-0 mt-2 type-body">{h.explanation}</p>}
      {!demoted && evidenceUnder(h.evidenceIds)}
      {sourcesUnder(h.evidenceIds)}
    </li>
  );

  return (
    <div className="report-column">
      <AlertBand alerts={alerts} />

      <header className="mt-8">
        {/* Headline then deck, which is what the two fields are for: the one
            sentence that is the answer, and the paragraph that expands it.
            Before any write-up, the leading claim stands in for the headline. */}
        <h1 className="m-0 type-title">
          {submitted === null ? "Investigation" : submitted.headline}
        </h1>
        {submitted === null && findings[0] !== undefined && (
          <p className="m-0 mt-3 type-heading">
            {claimOf(record.candidates, findings[0])}
          </p>
        )}
        {submitted !== null && (
          <p className="m-0 mt-3 type-prose">{submitted.summary}</p>
        )}
        {submitted !== null && (
          <p className="m-0 mt-3 type-body text-ink-muted">
            Affected: {submitted.affected}
          </p>
        )}
        {/* Stated once for the whole report rather than on each of its clocks.
            Every time below reads in the zone of whoever opened it, so a time
            quoted out of here means nothing without the zone beside it. */}
        <p className="m-0 mt-3 type-body text-ink-muted">
          Times in {zoneName()}
        </p>
      </header>

      <Facts
        record={record}
        evidence={evidence}
        decisions={decisions}
        span={span}
      />

      {submitted !== null && submitted.impact.trim() !== "" && (
        <section className="mt-12">
          <BandHeading>Impact</BandHeading>
          <p className="m-0 type-body">{submitted.impact}</p>
        </section>
      )}

      {submitted !== null && submitted.recommendation.trim() !== "" && (
        <Band heading="Recommendation">
          <div>
            <p className="m-0 type-body">{submitted.recommendation}</p>
            {/* Named once, beside what to do, and pointing at the timeline
                rather than repeating it. */}
            {approved.length > 0 && (
              <p className="m-0 mt-3 type-body text-ink-muted">
                <span className="text-ok">
                  {approved.length === 1
                    ? "One write you approved"
                    : `${approved.length} writes you approved`}
                </span>{" "}
                ran during this investigation.{" "}
                <a href={`#${TIMELINE_ID}`} className="link">
                  See it on the timeline
                </a>
              </p>
            )}
          </div>
        </Band>
      )}

      {rows.length > 0 && (
        <section id={TIMELINE_ID} className="mt-12 scroll-mt-6">
          <BandHeading>What happened</BandHeading>
          <ul className="m-0 mt-4 list-none p-0">
            {rows.map((row, i) => (
              <TimelineRow key={`${row.at}-${row.kind}-${i}`} row={row} />
            ))}
          </ul>
        </section>
      )}

      {findings.length > 0 && (
        <Band heading="What held up">
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {findings.map((h) => claim(h))}
          </ul>
        </Band>
      )}

      {ruledOut.length > 0 && (
        <section className="mt-12">
          {/* Statement over reason, with the sources but no drawing: the proof
              of a dismissal is one click away in the transcript. */}
          <BandHeading>Ruled out</BandHeading>
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {ruledOut.map((h) => (
              <li key={h.id}>
                <h4 className="m-0 type-item text-ink-muted">
                  {VERDICT_VIEW[h.verdict].label}
                </h4>
                <p className="m-0 mt-1 type-item text-ink-muted">
                  {claimOf(record.candidates, h)}
                </p>
                {h.explanation && (
                  <p className="m-0 mt-1.5 type-body text-ink-muted">
                    {h.explanation}
                  </p>
                )}
                {sourcesUnder(h.evidenceIds)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {superseded.length > 0 && (
        <Band heading="Superseded">
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {superseded.map((h) => claim(h, true))}
          </ul>
        </Band>
      )}
    </div>
  );
}
