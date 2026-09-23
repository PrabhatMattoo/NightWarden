import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import type { ReportCardItem } from "./types.js";
import { GateCard } from "./GateCard.js";

/* The write-up is the last thing a run does, so a run that could not write it up
   did not finish. This offers to run it again, the way any failed run would. */
export function ReportCardPanel({
  item,
  retrying = false,
  onRetry,
}: {
  item: ReportCardItem;
  retrying?: boolean;
  onRetry?: () => void;
}): React.JSX.Element | null {
  if (item.state.phase !== "failed") return null;

  return (
    <GateCard data-testid="report-card" data-phase="failed">
      <p className="type-body">The run did not finish.</p>
      <Button size="sm" disabled={retrying} onClick={() => onRetry?.()}>
        {retrying && <Spinner className="size-4" />}
        Try again
      </Button>
    </GateCard>
  );
}
