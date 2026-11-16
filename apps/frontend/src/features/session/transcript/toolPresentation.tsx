// The row names the call and the body is one click inside it. Expansion is a
// thread line: at rail width a box per tool buries the conversation.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import {
  onReveal,
  revealTarget,
  endReveal,
  REVEAL_MS,
} from "./revealToolCall.js";
import { cn } from "@/shared/lib/utils";
import { isTool, parseTargetKey } from "@nightwarden/shared";
import type { ApprovalStatus, ToolName } from "@nightwarden/shared";
import { stringAt as inputString } from "@/shared/lib/toolResult";
import type { ToolCallItem } from "./types.js";
import { DisclosureChevron } from "./DisclosureChevron.js";
import { DiffCard, parseFileChange } from "./DiffCard.js";
import { PRCard, parsePullRequestResult } from "./PRCard.js";
import { parseCommandRun } from "./TerminalCard.js";

// Beyond this the body scrolls behind an explicit opt-in. The runner's own 64KB
// cap is for safety; this much tighter one is for reading.
const BODY_MAX_LINES = 8;

// Shared with the approval card, which labels the same three as one action.
export const COMMAND_TOOLS: readonly ToolName[] = [
  "DockerExec",
  "K8sExec",
  "Bash",
];

// Service tools address one service by target key; server tools name a server.
// Shared with the report, so a cited call names its target the same way there.
export function targetOf(input: Record<string, unknown>): string | null {
  const target = input["target"];
  if (typeof target === "string") {
    return parseTargetKey(target)?.name ?? target;
  }
  return inputString(input, "server");
}

// The exec tools carry a program and its arguments; repo Bash carries a shell
// string. Shared with the approval card, where what is read has to be what runs.
export function commandLineOf(input: Record<string, unknown>): string | null {
  const executable = input["executable"];
  if (typeof executable === "string") {
    const args = Array.isArray(input["args"]) ? input["args"].map(String) : [];
    return [executable, ...args].join(" ");
  }
  return inputString(input, "command");
}

const MONO = "font-mono type-body  text-ink-muted";

// Capped text with an explicit, counted opt-in. "Show all" reveals exactly what
// the runner returned, already redacted and already size-capped upstream.
function CappedText({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const hidden = lines.length - BODY_MAX_LINES;

  if (hidden <= 0)
    return (
      <pre className={cn(MONO, "m-0 whitespace-pre-wrap wrap-break-word")}>
        {text}
      </pre>
    );

  return (
    <div>
      <pre
        className={cn(
          MONO,
          "m-0 whitespace-pre-wrap wrap-break-word",
          open && "max-h-72 overflow-auto",
        )}
      >
        {open ? text : lines.slice(0, BODY_MAX_LINES).join("\n")}
      </pre>
      <Button variant="link" className="mt-2" onClick={() => setOpen(!open)}>
        {open ? "Show less" : `Show all ${lines.length} lines`}
      </Button>
    </div>
  );
}

/* Only the two a raw block cannot serve: a question needs the question beside
   the answer, and a command needs its own line above its output. */
function ToolBody({
  toolName,
  input,
  result,
}: {
  toolName: string;
  input: Record<string, unknown>;
  result: unknown;
}): React.JSX.Element {
  // Before the record guard: an answer is a bare string, so asRecord would send
  // it to the raw fallback and print the question nowhere.
  if (isTool(toolName, "AskUserQuestion")) {
    const answer = typeof result === "string" ? result : JSON.stringify(result);
    return (
      <dl className="m-0 flex flex-col gap-2">
        {[
          ["Asked", inputString(input, "question") ?? ""],
          ["You", answer],
        ].map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-16 shrink-0 type-body text-ink-muted">{label}</dt>
            <dd className="m-0 min-w-0 type-body wrap-break-word whitespace-pre-wrap text-ink-muted">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const run = isTool(toolName, ...COMMAND_TOOLS)
    ? parseCommandRun(result)
    : null;
  if (run !== null) {
    return (
      <div className="flex flex-col gap-2">
        <pre className={cn(MONO, "m-0 whitespace-pre-wrap wrap-break-word")}>
          <span className="text-ink-muted select-none">$ </span>
          {commandLineOf(input) ?? ""}
        </pre>
        {run.output.trim() === "" ? (
          <p className={cn(MONO, "m-0 text-ink-muted")}>(no output)</p>
        ) : (
          <CappedText text={run.output} />
        )}
      </div>
    );
  }

  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return <CappedText text={text} />;
}

// How a settled decision reads on the resolved row. "Declined" rather than
// "Rejected", to match the report and the language the card used when asking.
const DECISION_WORD: Record<ApprovalStatus, string> = {
  pending: "",
  approved: "Approved",
  rejected: "Declined",
  answered: "Answered",
  continued: "Continued",
};

function ToolRow({ item }: { item: ToolCallItem }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const { toolName, input } = item;

  // A citation opens the call it names and scrolls it into view, so the reader
  // lands on the evidence rather than on a collapsed row that looks like any other.
  useEffect(() => {
    const check = (): void => {
      if (revealTarget() !== item.toolCallId) return;
      setOpen(true);
      setRevealed(true);
      // Allow the collapsible height transitions (200ms) to finish
      // unfolding before smoothly scrolling, avoiding the double-jump layout shift.
      window.setTimeout(() => {
        rowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 200);
      window.setTimeout(() => {
        setRevealed(false);
        endReveal(item.toolCallId);
      }, REVEAL_MS);
    };
    // On mount too: the group may have just opened this row for the reveal.
    check();
    return onReveal(check);
  }, [item.toolCallId]);
  const result =
    item.state.phase === "complete"
      ? item.state.result
      : item.state.phase === "resolved"
        ? (item.state.result ?? null)
        : null;

  // Two different things, and conflating them put the sweep on a call that was
  // waiting: one has no result yet, the other is actually executing.
  const unanswered = result === null;
  const working = item.state.phase === "running";
  const failed = item.state.phase === "complete" && item.state.isError === true;
  const target = targetOf(input) ?? inputString(input, "path");
  // Who settled this call, drawn on the resolved row so the audit reads inline.
  const actor =
    item.state.phase === "resolved" ? (item.state.actor ?? null) : null;
  const decisionWord =
    item.state.phase === "resolved" ? DECISION_WORD[item.state.decision] : null;

  return (
    // Anchor for the report's evidence links: a citation there names the tool
    // call that produced it, and this is where that call lives.
    <div
      ref={rowRef}
      data-testid="tool-call"
      id={`tool-${item.toolCallId}`}
      data-revealed={revealed || undefined}
      className={cn(
        "-mx-2 scroll-mt-6 rounded-control px-2 transition-colors duration-(--duration-slow)",
        revealed && "bg-selected",
      )}
    >
      <Collapsible open={open} onOpenChange={setOpen} disabled={unanswered}>
        <CollapsibleTrigger
          disabled={unanswered}
          nativeButton
          className="group flex w-full items-baseline gap-1.5 py-1 text-left text-ink-muted"
        >
          {/* The sweep is what says "still going", so the name carries it and
              the row needs no second word beside it. */}
          <span
            data-testid="tool-call-name"
            className={cn(
              "shrink-0 font-mono type-heading transition-colors group-hover:text-ink-base",
              working && "live",
            )}
          >
            {toolName}
          </span>
          {target !== null && (
            <span className="shrink-0 font-mono type-prose transition-colors group-hover:text-ink-base">
              {target}
            </span>
          )}
          {failed && (
            <span className="shrink-0 type-prose transition-colors group-hover:text-ink-base">
              failed
            </span>
          )}
          {actor !== null && decisionWord !== null && (
            <span className="min-w-0 truncate type-prose transition-colors group-hover:text-ink-base">
              {decisionWord} by {actor.name} ({actor.email})
            </span>
          )}
          <DisclosureChevron openable={!unanswered} />
        </CollapsibleTrigger>

        {/* No rule and no indent: the body is the evidence the row was opened
          for, so nothing here sets it back. Tight above because it belongs to
          the row, looser below because it is finished. */}
        {!unanswered && (
          <CollapsibleContent>
            <div className="mt-1 mb-4">
              <ToolBody toolName={toolName} input={input} result={result} />
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}

/* The presentation registry. Tools whose result IS a rendered artifact keep
   their bespoke component; everything else is a row. */
export function ToolCall({
  item,
}: {
  item: ToolCallItem;
}): React.JSX.Element | null {
  const { toolName, input } = item;
  const result =
    item.state.phase === "complete"
      ? item.state.result
      : item.state.phase === "resolved"
        ? (item.state.result ?? null)
        : null;

  // The report card already announces this act, so a row for it would say the
  // same thing twice. Recording a finding is a step, and stays visible.
  if (isTool(toolName, "ComposeReport")) return null;

  if (isTool(toolName, "Edit", "Write")) {
    const change = result === null ? null : parseFileChange(result);
    if (change !== null)
      return <DiffCard toolName={toolName} change={change} />;
  }

  if (isTool(toolName, "OpenPullRequest")) {
    const pr = result === null ? null : parsePullRequestResult(result);
    if (pr !== null) return <PRCard pr={pr} />;
  }

  void input;
  return <ToolRow item={item} />;
}
