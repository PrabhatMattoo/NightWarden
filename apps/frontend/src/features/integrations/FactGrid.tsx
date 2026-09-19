import { Fragment, type ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import { DESCRIPTION } from "@/shared/ui/Page";

export interface Fact {
  label: string;
  value: ReactNode;
}

// Every connection's facts at one size and tone: a muted label, a value in ink,
// so no page styles its endpoint one way and its recency another.
export function FactGrid({ facts }: { facts: Fact[] }): React.JSX.Element {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2.5">
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <dt className={cn("m-0", DESCRIPTION)}>{fact.label}</dt>
          <dd className="m-0 min-w-0 text-sm break-words">{fact.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/* The connected half of an integration page: its facts as a grid, an optional
   note for what a fact cannot say, then the actions that change it. */
export function ConnectedState({
  facts,
  note,
  actions,
}: {
  facts: Fact[];
  note?: ReactNode;
  actions: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <FactGrid facts={facts} />
      {note}
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}
