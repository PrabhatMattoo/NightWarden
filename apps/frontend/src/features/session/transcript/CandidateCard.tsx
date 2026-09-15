import { useState } from "react";
import { ChevronRight } from "lucide-react";

import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/shared/ui/collapsible";
import { cn } from "@/shared/lib/utils";
import { revealToolCall } from "./revealToolCall.js";
import type { CandidateRow } from "./types.js";

// The same ranking as the report, with a word so colour is never the only
// signal: accent for the cause, ink for a standing role, grey for a dismissal.
const STATE: Record<
  CandidateRow["state"],
  { label: string; className: string; struck?: boolean }
> = {
  open: { label: "open", className: "text-wait" },
  root_cause: { label: "root cause", className: "text-primary-ink" },
  trigger: { label: "trigger", className: "text-foreground" },
  symptom: { label: "symptom", className: "text-foreground" },
  contributing_factor: { label: "contributing", className: "text-foreground" },
  disproven: { label: "ruled out", className: "text-ink-subtle", struck: true },
  untestable: { label: "untestable", className: "text-ink-subtle" },
};

// Counts before statements: docked above the input, the one line has to answer
// whether the run still owes a verdict without being opened.
function summary(rows: CandidateRow[]): string {
  const open = rows.filter((r) => r.state === "open").length;
  const settled = rows.length - open;
  return `${rows.length} opened · ${settled} settled · ${open} open`;
}

/* The board of candidates, docked above the message box: it is live state rather
   than a message, so it holds one place instead of ageing where it was drawn. */
export function CandidateCard({
  rows,
}: {
  rows: CandidateRow[];
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          nativeButton
          className="group flex w-full items-center gap-2 px-4 py-3 text-left text-sm"
        >
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) group-aria-expanded:rotate-90"
          />
          <span className="font-medium">Candidates</span>
          <span className="text-xs text-muted-foreground">{summary(rows)}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => {
              const view = STATE[row.state];
              const findingId = row.findingId;
              return (
                <li
                  key={row.id}
                  className="grid grid-cols-[max-content_1fr_max-content] items-baseline gap-x-3 gap-y-1 border-t border-border px-4 py-3"
                >
                  <span className="font-mono text-xs text-ink-subtle">
                    {row.id}
                  </span>
                  <span
                    className={cn(
                      "text-sm",
                      view.struck &&
                        "text-muted-foreground line-through decoration-muted-foreground/50",
                    )}
                  >
                    {row.statement}
                  </span>
                  {/* The finding carrying the verdict, so the row the reader
                      wants is one click away rather than a scroll hunt. */}
                  {findingId === undefined ? (
                    <span
                      className={cn(
                        "text-xs whitespace-nowrap",
                        view.className,
                      )}
                    >
                      {view.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => revealToolCall(findingId)}
                      className={cn(
                        "text-xs whitespace-nowrap underline-offset-4 hover:underline",
                        view.className,
                      )}
                    >
                      {view.label}
                    </button>
                  )}
                  {row.note !== undefined && (
                    <span className="col-start-2 col-end-4 text-xs leading-relaxed text-muted-foreground">
                      {row.note}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
