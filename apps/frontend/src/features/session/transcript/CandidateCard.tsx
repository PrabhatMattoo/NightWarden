import { useState } from "react";

import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/shared/ui/collapsible";
import { cn } from "@/shared/lib/utils";
import { DisclosureChevron } from "./DisclosureChevron.js";
import type { CandidateRow } from "./types.js";

// The same ranking as the report, with a word so colour is never the only
// signal: accent for the cause, ink for a standing role, grey for a dismissal.
const STATE: Record<
  CandidateRow["state"],
  { label: string; className: string; struck?: boolean }
> = {
  open: { label: "open", className: "text-warn" },
  root_cause: { label: "root cause", className: "text-accent-ink" },
  trigger: { label: "trigger", className: "text-ink-base" },
  symptom: { label: "symptom", className: "text-ink-base" },
  contributing_factor: { label: "contributing", className: "text-ink-base" },
  disproven: { label: "ruled out", className: "text-ink-muted", struck: true },
  untestable: { label: "untestable", className: "text-ink-muted" },
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
    <div className="tile overflow-hidden bg-ground">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          nativeButton
          className="group flex w-full items-center gap-2 px-4 py-3 text-left type-body"
        >
          <span className="emphasis">Candidates</span>
          <span className="type-body text-ink-muted">{summary(rows)}</span>
          <DisclosureChevron />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => {
              const view = STATE[row.state];
              return (
                <li
                  key={row.id}
                  className="grid grid-cols-key-end items-baseline gap-x-3 gap-y-1 border-t-hairline border-edge px-4 py-3"
                >
                  <span className="font-mono type-body text-ink-muted">
                    {row.id}
                  </span>
                  <span
                    className={cn(
                      "type-item",
                      view.struck &&
                        "text-ink-muted line-through decoration-edge-strong",
                    )}
                  >
                    {row.statement}
                  </span>
                  <span
                    className={cn(
                      "type-body whitespace-nowrap",
                      view.className,
                    )}
                  >
                    {view.label}
                  </span>
                  {row.note !== undefined && (
                    <span className="col-start-2 col-end-4 type-body text-ink-muted">
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
