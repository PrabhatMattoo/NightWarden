import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CandidateCardItem,
  FrontendEvent,
  ReportCardItem,
  TranscriptItem,
} from "@nightwarden/shared";
import type { ActivityLine } from "@/features/session/transcript/types";
import { transcriptItemKey } from "@nightwarden/shared";
import { mergeTranscript } from "@/features/session/transcript/mergeTranscript";

import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
} from "@/shared/ui/message-scroller";
import { cn } from "@/shared/lib/utils";
import { toast } from "@/shared/lib/toast";
import { newClientId } from "@/shared/lib/clientId";
import { useFrontendEvents } from "@/shared/events/FrontendEventsProvider";
import { useSession } from "@/features/session/useSession";
import { prependSession } from "@/features/session/useSessions";
import { sessionQuery } from "@/features/session/queries";
import { ChatInput } from "@/features/session/transcript/ChatInput";
import {
  applyLiveEvent,
  hasActiveStream,
} from "@/features/session/transcript/liveConverter";
import {
  TranscriptItemRenderer,
  PinnedGate,
} from "@/features/session/transcript/TranscriptItemRenderer";
import { WorkingIndicator } from "@/features/session/transcript/WorkingIndicator";
import { RunGroup } from "@/features/session/transcript/RunGroup";
import { segmentRuns } from "@/features/session/transcript/segmentRuns";
import { apiFetch } from "@/shared/api/client";

// A stable empty default, so an unloaded transcript does not remount the column.
const EMPTY_ITEMS: TranscriptItem[] = [];

// What the report card's button sends. One sentence, so the run picks up under
// the same gate as any other message rather than through a door of its own.
const FINISH_UP_MESSAGE =
  "Settle any candidate still open and write up the investigation.";

// A gate stops the whole run whichever kind it is, so both pin above the input
// and both leave their row behind in the group where the call was made.
function dockedCard(items: TranscriptItem[]): TranscriptItem | undefined {
  for (const item of items) {
    if (item.kind === "continue_card") {
      if (item.state.phase === "awaiting_human") return item;
      continue;
    }
    if (item.kind === "tool_call" && item.state.phase === "awaiting_human")
      return item;
  }
  return undefined;
}

// Every run rewrites it, so no position among the messages is right: written
// where it happened it goes stale, pushed last it sits under a later question.
function dockedReport(items: TranscriptItem[]): ReportCardItem | undefined {
  return items.find(
    (item): item is ReportCardItem => item.kind === "report_card",
  );
}

// Live state on the same terms: every finding rewrites the board, so it holds
// one place above the input rather than ageing where the run opened it.
function dockedCandidates(
  items: TranscriptItem[],
): CandidateCardItem | undefined {
  return items.find(
    (item): item is CandidateCardItem => item.kind === "candidate_card",
  );
}

function ScrollToEndChatInput(
  props: React.ComponentProps<typeof ChatInput>,
): React.JSX.Element {
  const { scrollToEnd } = useMessageScroller();
  const originalOnSend = props.onSend;

  const handleSend = useCallback(
    (text: string, clientMessageId: string) => {
      originalOnSend?.(text, clientMessageId);
      requestAnimationFrame(() => {
        scrollToEnd({ behavior: "smooth" });
      });
    },
    [originalOnSend, scrollToEnd],
  );

  return <ChatInput {...props} onSend={handleSend} />;
}

function TranscriptColumn({
  items,
  activityLine,
  foldsWhenSettled,
  runActive,
  submittingToolUseId,
  onResolve,
  onRetryReport,
}: {
  // Already merged and already stripped of whatever is docked: the column draws
  // the list it is handed and decides nothing about what belongs in it.
  items: TranscriptItem[];
  // What the run is doing right now; null once the transcript speaks for itself.
  activityLine: ActivityLine | null;
  // Only an investigation folds a settled run away; a chat keeps it open.
  foldsWhenSettled: boolean;
  // Whether a run is live, so the last segment reads as Working rather than
  // settling its answer out early.
  runActive: boolean;
  submittingToolUseId: string | null;
  onResolve: (
    toolCallId: string,
    action: "approve" | "reject",
    reason?: string,
  ) => void;
  onRetryReport: () => void;
}): React.JSX.Element {
  const nodes = segmentRuns(items, runActive);
  return (
    <MessageScrollerContent
      data-testid="transcript-column"
      role="log"
      aria-label="Session transcript"
      className="mx-auto w-full max-w-narrow gap-0 px-6 pb-8 pt-4"
    >
      {nodes.map((node, index) => {
        const key =
          node.kind === "group" ? node.id : transcriptItemKey(node.item);
        // The run that is still going owns the line; anything else stands alone.
        const owned =
          node.kind === "group" && node.live && index === nodes.length - 1;
        const spacing =
          index === 0
            ? "mt-0"
            : node.kind === "item" && node.item.kind === "user_turn"
              ? "mt-8"
              : "mt-2";
        return (
          <MessageScrollerItem key={key} className={spacing}>
            {node.kind === "group" ? (
              <RunGroup
                node={node}
                foldsWhenSettled={foldsWhenSettled}
                activityLine={owned ? activityLine : null}
                submittingToolUseId={submittingToolUseId}
                onResolve={onResolve}
                onRetryReport={onRetryReport}
              />
            ) : (
              <TranscriptItemRenderer
                item={node.item}
                submitting={
                  "toolCallId" in node.item &&
                  node.item.toolCallId === submittingToolUseId
                }
                onResolve={onResolve}
                onRetryReport={onRetryReport}
              />
            )}
          </MessageScrollerItem>
        );
      })}
      {activityLine !== null &&
        !nodes.some((n) => n.kind === "group" && n.live) && (
          <MessageScrollerItem className={nodes.length === 0 ? "mt-0" : "mt-2"}>
            <WorkingIndicator
              label={activityLine.text}
              waiting={activityLine.waiting}
            />
          </MessageScrollerItem>
        )}
    </MessageScrollerContent>
  );
}

/** /agent renders with no id; the two $id routes pass the param. */
export function SessionView({
  sessionId: sessionIdFromRoute = null,
  reportOpen: _reportOpen = false,
}: {
  sessionId?: string | null;
  // The candidate board is docked only for the run; once the report is open
  // beside the chat, the board's job is done and it steps aside.
  reportOpen?: boolean;
} = {}): React.JSX.Element {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    sessionIdFromRoute,
  );
  const activeSessionIdRef = useRef<string | null>(sessionIdFromRoute);

  const [liveItems, setLiveItems] = useState<TranscriptItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  // Optimistic echo of the sent message, shown until its persisted row lands.
  const [pendingEcho, setPendingEcho] = useState<{
    id: string;
    text: string;
  } | null>(null);
  // Live status line (provider retries, sandbox provisioning); any other run
  // event clears it.
  const [activityNotice, setActivityNotice] = useState<{
    text: string;
    waiting: boolean;
  } | null>(null);
  const queryClient = useQueryClient();

  const session = useSession(activeSessionId);

  // Read once: after that the stream is the truth, and a refetch mid-suspend
  // would undo it.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (activeSessionId === null || session === null) return;
    if (session.sessionId !== activeSessionId) return;
    if (seededFor.current === activeSessionId) return;
    seededFor.current = activeSessionId;
    if (session.running) setIsRunning(true);
  }, [session, activeSessionId]);

  const prevRouteIdRef = useRef<string | null>(sessionIdFromRoute);
  useEffect(() => {
    const prev = prevRouteIdRef.current;
    const curr = sessionIdFromRoute;
    prevRouteIdRef.current = curr;

    if (curr === null) {
      activeSessionIdRef.current = null;
      setActiveSessionId(null);
      setLiveItems([]);
      setIsRunning(false);
      setPendingEcho(null);
      setActivityNotice(null);
      seededFor.current = null;
      return;
    }

    if (prev !== null && prev !== curr) {
      setLiveItems([]);
      setIsRunning(false);
      setPendingEcho(null);
      setActivityNotice(null);
      seededFor.current = null;
    }

    activeSessionIdRef.current = curr;
    setActiveSessionId(curr);
  }, [sessionIdFromRoute]);

  const persistedItems = session?.transcript ?? EMPTY_ITEMS;

  const handleSessionCreated = useCallback(
    (newId: string, firstMessage: string) => {
      activeSessionIdRef.current = newId;
      setActiveSessionId(newId);

      // Typing here opens a chat. An investigation is opened by an alert, so
      // the row goes to the chat list and never moves between them.
      prependSession(queryClient, {
        sessionId: newId,
        title: firstMessage.slice(0, 60),
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        investigation: false,
        severityLabel: null,
        status: null,
        statusLine: null,
        awaitingHumanInput: false,
      });
    },
    [queryClient],
  );

  const handleEnvelope = useCallback(
    (env: FrontendEvent) => {
      const sid = activeSessionIdRef.current;
      if (!sid) return;

      if (env.type === "SANDBOX_STATUS") {
        const { sessionId, stage } = env.payload;
        if (sessionId !== sid) return;
        const text =
          stage === "cloning"
            ? "Preparing sandbox - cloning the repository\u2026"
            : stage === "starting"
              ? "Preparing sandbox - starting the container\u2026"
              : stage === "installing"
                ? "Preparing sandbox - installing dependencies\u2026"
                : null;
        setActivityNotice(text === null ? null : { text, waiting: false });
        return;
      }

      if (env.type === "RUN_RETRYING") {
        const { sessionId, summary } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(true);
        setActivityNotice({ text: summary, waiting: true });
        setLiveItems((prev) => applyLiveEvent(prev, env, sid));
        return;
      }

      if (env.type === "MESSAGE") {
        const { sessionId } = env.payload;
        if (sessionId !== sid) return;
        // A persisted row, not a lifecycle signal - never touch isRunning here.
        // Housekeeping, not correctness: the render already hides a streamed
        // turn the transcript holds. This only bounds the buffer.
        void queryClient
          .invalidateQueries({ queryKey: sessionQuery(sid).queryKey })
          .then(() => setLiveItems([]));
        return;
      }

      if (env.type === "RUN_FINISHED") {
        // Settle run state only; the streamed rows stay until each one's own
        // MESSAGE lands, so a fast finish never blanks the answer between them.
        const { sessionId } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(false);
        setActivityNotice(null);
        return;
      }

      if (env.type === "RUN_STOPPED") {
        const { sessionId } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(false);
        setActivityNotice(null);
        setPendingEcho(null);
        setLiveItems([]);
        return;
      }

      if (env.type === "RUN_FAILED") {
        if (env.payload.sessionId !== sid) return;
        setIsRunning(false);
        setActivityNotice(null);
        setPendingEcho(null);
        setLiveItems([]);
        void queryClient.invalidateQueries({
          queryKey: sessionQuery(sid).queryKey,
        });
        return;
      }

      // A gated tool suspends the run for a human: it is terminal for the run
      // process, so settle run state, then fall through to render the card.
      if (env.type === "HUMAN_INPUT_REQUIRED") {
        if (env.payload.sessionId === sid) {
          setIsRunning(false);
          setActivityNotice(null);
        }
      }

      if (env.type === "TEXT_MESSAGE_CONTENT") {
        if (env.payload.sessionId === sid) {
          setIsRunning(true);
          setActivityNotice(null);
        }
      }

      setLiveItems((prev) => applyLiveEvent(prev, env, sid));
    },
    [queryClient],
  );

  const respond = useMutation({
    mutationFn: (vars: { toolCallId: string; body: Record<string, unknown> }) =>
      apiFetch<void>(`/api/sessions/${activeSessionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars.body),
      }),
    onError: (err) => {
      toast.show({
        title: "Response not sent",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const handleResolve = useCallback(
    (toolCallId: string, action: "approve" | "reject", reason?: string) => {
      setIsRunning(true);
      // Nothing is stamped on the item: the decision in flight belongs to this
      // browser, and `submitting` below is what draws it.
      respond.mutate({
        toolCallId,
        // The comment rides the same request the decision does; the API feeds it
        // to the agent so a rejection says why instead of only saying no.
        body: {
          decision: action,
          ...(reason !== undefined && { text: reason }),
        },
      });
    },
    [respond],
  );

  /* A person pressing the card is a person asking, so it resumes the session the
   way typing does and the ask stays visible in the transcript in their voice. */
  const finishUp = useMutation({
    mutationFn: (clientMessageId: string) =>
      apiFetch<void>(`/api/sessions/${activeSessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: FINISH_UP_MESSAGE, clientMessageId }),
      }),
    onError: (err) => {
      toast.show({
        title: "Could not resume the investigation",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const handleRetryReport = useCallback(() => {
    const clientMessageId = newClientId();
    setPendingEcho({ id: clientMessageId, text: FINISH_UP_MESSAGE });
    setIsRunning(true);
    finishUp.mutate(clientMessageId);
  }, [finishUp]);

  const handleAnswer = useCallback(
    (toolCallId: string, answer: string | string[]) => {
      const text = Array.isArray(answer) ? answer.join(", ") : answer;
      setIsRunning(true);
      respond.mutate({ toolCallId, body: { text } });
    },
    [respond],
  );

  useFrontendEvents(handleEnvelope);

  const handleSend = useCallback((text: string, clientMessageId: string) => {
    setPendingEcho({ id: clientMessageId, text });
    // An active run with nothing streaming is what surfaces the working
    // animation, and a just-answered card is left untouched so it survives.
    setIsRunning(true);
  }, []);

  // The POST never reached the API, so the server has no record of the
  // message: undo the echo (ChatInput restores the text).
  const handleSendFailed = useCallback(() => {
    setPendingEcho(null);
    setLiveItems([]);
    setIsRunning(false);
  }, []);

  const allItems = mergeTranscript({
    persisted: persistedItems,
    live: liveItems,
    pendingEcho,
  });
  const dockedItem = dockedCard(allItems);
  const reportItem = dockedReport(allItems);
  const candidateItem = dockedCandidates(allItems);
  const docked = new Set(
    [reportItem, candidateItem].flatMap((item) =>
      item ? [transcriptItemKey(item)] : [],
    ),
  );
  const inlineItems = allItems.filter(
    (item) => !docked.has(transcriptItemKey(item)),
  );
  const submittingToolUseId = respond.isPending
    ? (respond.variables?.toolCallId ?? null)
    : null;
  /* The one live line: a server notice whenever there is one, the placeholder
     while a run works silently, and nothing once the transcript speaks. The
     notice is not gated on the run, because a sandbox provisions before one. */
  const awaitingHuman = dockedItem !== undefined;
  // Suspended on a person is still the same run, so the group stays live and
  // the clock keeps counting until the answer lands.
  const runActive = isRunning || awaitingHuman;
  /* Suspended on a person, isRunning is already false, so the line falls silent
     and the card is left as the one thing asking. */
  const activityLine =
    activityNotice ??
    (isRunning && !hasActiveStream(liveItems)
      ? { text: "Thinking", waiting: false }
      : null);

  return (
    <MessageScrollerProvider defaultScrollPosition="end">
      <div className="flex h-full flex-col">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <TranscriptColumn
              items={inlineItems}
              activityLine={activityLine}
              foldsWhenSettled={session?.investigation === true}
              runActive={runActive}
              submittingToolUseId={submittingToolUseId}
              onResolve={handleResolve}
              onRetryReport={handleRetryReport}
            />
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>

        {/* Highest of the three: it is the standing state of the work, while
            the two below it are things asking to be acted on. Dismissed once
            a report stands, and restored if a later run opens new candidates. */}
        {candidateItem &&
          (reportItem?.kind !== "report_card" ||
            reportItem.state.phase !== "ready" ||
            candidateItem.rows.some((row) => row.state === "open")) && (
            <div className="mx-auto mb-2 w-full max-w-narrow px-6">
              <TranscriptItemRenderer
                item={candidateItem}
                onResolve={handleResolve}
                onRetryReport={handleRetryReport}
              />
            </div>
          )}

        {/* Only a failed write-up docks a card now; ready opens the report on
            its own, so what is left is the one thing asking to be acted on. */}
        {reportItem?.kind === "report_card" &&
          reportItem.state.phase === "failed" && (
            <div className="mx-auto mb-2 w-full max-w-narrow px-6">
              <TranscriptItemRenderer
                item={reportItem}
                onResolve={handleResolve}
                onRetryReport={handleRetryReport}
              />
            </div>
          )}

        {dockedItem && (
          <div className="mx-auto mb-2 w-full max-w-narrow px-6">
            <PinnedGate
              item={dockedItem}
              submitting={
                "toolCallId" in dockedItem &&
                dockedItem.toolCallId === submittingToolUseId
              }
              onResolve={handleResolve}
              onAnswer={handleAnswer}
            />
          </div>
        )}

        <ScrollToEndChatInput
          sessionId={activeSessionId}
          isRunning={isRunning}
          onSessionCreated={handleSessionCreated}
          onSend={handleSend}
          onSendFailed={handleSendFailed}
        />

        {/* Half the room below the composer until a message is sent, which puts
            it in the middle; sending closes it without waiting on the server. */}
        <div
          aria-hidden
          className={cn(
            "shrink-0",
            activeSessionId === null && pendingEcho === null
              ? "grow"
              : "grow-0",
          )}
        />
      </div>
    </MessageScrollerProvider>
  );
}
