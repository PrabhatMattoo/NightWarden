import { useEffect, useRef, useState } from "react";
import { transcriptItemKey } from "@nightwarden/shared";
import { Collapsible, CollapsibleContent } from "@/shared/ui/collapsible";
import type { RunNode } from "./segmentRuns.js";
import type { ActivityLine } from "./types.js";
import { DisclosureChevron } from "./DisclosureChevron.js";
import { formatDuration, useRunSeconds } from "./runDuration.js";
import { onReveal, revealTarget } from "./revealToolCall.js";
import { TranscriptItemRenderer } from "./TranscriptItemRenderer.js";
import { WorkingIndicator } from "./WorkingIndicator.js";

type GroupNode = Extract<RunNode, { kind: "group" }>;

/* One run's work under a header that reads "Working for Xs" live and "Worked
   for Xm Ys" settled, with the answer standing below the group, not inside it. */
export function RunGroup({
  node,
  foldsWhenSettled = false,
  activityLine = null,
  submittingToolUseId,
  onResolve,
  onRetryReport,
}: {
  node: GroupNode;
  // An investigation is scanned, so its settled runs fold their work away; a
  // chat is read, and hiding what the agent said is never right there.
  foldsWhenSettled?: boolean;
  // What the run is doing right now, drawn as the last thing inside the group
  // so it sits under the header rather than beside it.
  activityLine?: ActivityLine | null;
  submittingToolUseId?: string | null;
  onResolve?: (
    toolCallId: string,
    action: "approve" | "reject",
    reason?: string,
  ) => void;
  onRetryReport?: () => void;
}): React.JSX.Element {
  const opensFor = (live: boolean): boolean => live || !foldsWhenSettled;
  const [open, setOpen] = useState(() => opensFor(node.live));
  // Open while the run is live, and once it settles only where work folds away.
  const wasLive = useRef(node.live);
  useEffect(() => {
    if (wasLive.current !== node.live) setOpen(opensFor(node.live));
    wasLive.current = node.live;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.live, foldsWhenSettled]);

  // A citation into one of these calls opens the group so the row can be reached.
  useEffect(() => {
    const ids = new Set(
      node.items.flatMap((item) =>
        "toolCallId" in item ? [item.toolCallId] : [],
      ),
    );
    const check = (): void => {
      const target = revealTarget();
      if (target !== null && ids.has(target)) setOpen(true);
    };
    check();
    return onReveal(check);
  }, [node.items]);

  /* A live run always has a header, because prose arriving now says nothing
     about whether a tool follows it; a settled one keeps it only if there is
     work to open. */
  const earned = node.live || node.items.length > 0;
  // Nothing behind the header yet, so it reads as a status rather than a control.
  const disclosable = node.items.length > 0;
  const seconds = useRunSeconds(node);
  const label = `${node.live ? "Working" : "Worked"} for ${formatDuration(seconds)}`;

  return (
    <div data-testid="run-group" data-live={node.live || undefined}>
      <Collapsible open={earned}>
        <CollapsibleContent>
          {/* A counter on its own is a status, so it offers no control until the
              run has work behind it to open. */}
          {disclosable ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((prev) => !prev)}
              className="group flex w-full items-center gap-1.5 py-1 text-left text-base"
            >
              <span
                data-testid="run-group-label"
                className="text-ink-subtle tabular-nums transition-colors group-hover:text-foreground"
              >
                {label}
              </span>
              <DisclosureChevron />
            </button>
          ) : (
            <p
              data-testid="run-group-label"
              className="m-0 py-1 text-base text-ink-subtle tabular-nums"
            >
              {label}
            </p>
          )}

          <Collapsible open={open}>
            <CollapsibleContent>
              <div className="flex flex-col gap-0">
                {node.items.map((item) => (
                  <div key={transcriptItemKey(item)} className="mt-1">
                    <TranscriptItemRenderer
                      item={item}
                      submitting={
                        "toolCallId" in item &&
                        item.toolCallId === submittingToolUseId
                      }
                      onResolve={onResolve}
                      onRetryReport={onRetryReport}
                    />
                  </div>
                ))}
                {activityLine !== null && (
                  <div className="mt-1">
                    <WorkingIndicator
                      label={activityLine.text}
                      waiting={activityLine.waiting}
                    />
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CollapsibleContent>
      </Collapsible>

      {node.answer !== null && (
        <div className="mt-2">
          <TranscriptItemRenderer item={node.answer} />
        </div>
      )}
    </div>
  );
}
