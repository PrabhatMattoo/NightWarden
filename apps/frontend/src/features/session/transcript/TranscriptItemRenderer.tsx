import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CircleAlert } from "lucide-react";

import { Message } from "@/shared/ui/message";
import { IconLine } from "@/shared/ui/icon-line";
import { Bubble, BubbleContent } from "@/shared/ui/bubble";
import { MetaText } from "@/shared/ui/status";
import type { TranscriptItem, AlertArrivedItem } from "./types.js";
import { ToolCall } from "./toolPresentation.js";
import { CandidateCard } from "./CandidateCard.js";
import { ApprovalCardPanel } from "./ApprovalCardPanel.js";
import { ClarificationCardPanel } from "./ClarificationCardPanel.js";
import { ContinueCardPanel } from "./ContinueCardPanel.js";
import { ReportCardPanel } from "./ReportCardPanel.js";

function UserTurn({ text }: { text: string }): React.JSX.Element {
  return (
    <Message
      align="end"
      className="animate-in fade-in duration-(--duration-fast)"
      data-testid="user-turn"
    >
      <Bubble>
        <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
      </Bubble>
    </Message>
  );
}

function AgentMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="animate-in fade-in duration-(--duration-slow) prose prose-nightwarden max-w-none">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

// A provider outage or a stopped run reads as a quiet aside, not an alarm: fully
// muted and inline, so it never colours like the agent reasoning badly.
function ErrorNotice({ text }: { text: string }): React.JSX.Element {
  return (
    <IconLine
      icon={CircleAlert}
      role="status"
      data-testid="error-notice"
      className="animate-in fade-in type-prose text-ink-muted duration-(--duration-slow)"
    >
      <p className="m-0 whitespace-pre-wrap">{text}</p>
    </IconLine>
  );
}

// Why the agent changed course here. Deliberately a line, not a card: the
// report's alert band holds the detail, and this only has to mark the moment.
function AlertArrived({ item }: { item: AlertArrivedItem }): React.JSX.Element {
  // A rule the label rides, not a card: it has to span the column to read as a
  // boundary rather than as another item the agent produced.
  return (
    <div
      role="status"
      className="animate-in fade-in flex items-center gap-3 py-1 type-body duration-(--duration-slow)"
    >
      <span aria-hidden className="h-px w-6 shrink-0 bg-edge-faint" />
      {/* A word, and an uncoloured one. Severity is whatever the sender called
          it, so a tone here would be our reading of their vocabulary. */}
      <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-ink-muted">
        {item.severityLabel !== null && (
          <MetaText>{item.severityLabel}</MetaText>
        )}
        <span className="emphasis text-ink-base">{item.alertName}</span>
        <span>
          {item.opening === true
            ? "opened this investigation"
            : "fired during this run"}
        </span>
      </span>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-edge-faint" />
    </div>
  );
}

// A rule like an arriving alert rather than a card, since nothing produced it.
// The second clause answers the real question: the record did not forget.
function Compaction(): React.JSX.Element {
  return (
    <div
      role="status"
      className="animate-in fade-in flex items-center gap-3 py-1 type-body duration-(--duration-slow)"
    >
      <span aria-hidden className="h-px w-6 shrink-0 bg-edge-faint" />
      <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-ink-muted">
        <span className="emphasis text-ink-base">Context summarised</span>
        <span>to fit the model; everything above stays in the record</span>
      </span>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-edge-faint" />
    </div>
  );
}

/* What the run is suspended on, drawn as the card that takes the decision: a
   gated call, a question the agent asked, or an offer to carry on. */
export function PinnedGate({
  item,
  submitting = false,
  onResolve,
  onAnswer,
}: {
  item: TranscriptItem;
  submitting?: boolean;
  onResolve?: (
    toolCallId: string,
    action: "approve" | "reject",
    reason?: string,
  ) => void;
  onAnswer?: (toolCallId: string, answer: string | string[]) => void;
}): React.JSX.Element | null {
  if (item.kind === "continue_card")
    return (
      <ContinueCardPanel
        item={item}
        submitting={submitting}
        onResolve={
          onResolve ? (action) => onResolve(item.toolCallId, action) : undefined
        }
      />
    );
  if (item.kind !== "tool_call" || item.state.phase !== "awaiting_human")
    return null;
  return item.state.gate === "approval" ? (
    <ApprovalCardPanel
      item={item}
      submitting={submitting}
      onResolve={
        onResolve
          ? (action, reason) => onResolve(item.toolCallId, action, reason)
          : undefined
      }
    />
  ) : (
    <ClarificationCardPanel
      item={item}
      submitting={submitting}
      onAnswer={
        onAnswer ? (answer) => onAnswer(item.toolCallId, answer) : undefined
      }
    />
  );
}

export function TranscriptItemRenderer({
  item,
  submitting = false,
  onResolve,
  onRetryReport,
}: {
  item: TranscriptItem;
  submitting?: boolean;
  onResolve?: (
    toolCallId: string,
    action: "approve" | "reject",
    reason?: string,
  ) => void;
  onRetryReport?: () => void;
}): React.JSX.Element {
  switch (item.kind) {
    case "user_turn":
      return <UserTurn text={item.text} />;
    case "agent_text":
      return <AgentMarkdown text={item.text} />;
    case "error_text":
      // The text is already status-specific, and rendering it as prose would
      // make a provider outage read as the agent reasoning badly.
      return <ErrorNotice text={item.text} />;
    case "alert_arrived":
      return <AlertArrived item={item} />;
    case "compaction":
      return <Compaction />;
    // A call is a row whatever it waits on; a person decides on the card
    // pinned above the message box.
    case "tool_call":
      return <ToolCall item={item} />;
    case "candidate_card":
      return <CandidateCard rows={item.rows} />;
    case "report_card":
      return (
        <ReportCardPanel
          item={item}
          retrying={submitting}
          onRetry={onRetryReport}
        />
      );
    case "continue_card":
      return (
        <ContinueCardPanel
          item={item}
          submitting={submitting}
          onResolve={
            onResolve
              ? (action) => onResolve(item.toolCallId, action)
              : undefined
          }
        />
      );
  }
}
