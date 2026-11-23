import { DecisionButton } from "./DecisionButton.js";
import type { ContinueCardItem } from "./types.js";
import { GateCard } from "./GateCard.js";

export function ContinueCardPanel({
  item,
  submitting = false,
  onResolve,
}: {
  item: ContinueCardItem;
  submitting?: boolean;
  onResolve?: (action: "approve" | "reject") => void;
}): React.JSX.Element {
  const state = item.state;

  return (
    <GateCard data-testid="continue-card">
      <p className="type-body">
        Time budget reached. Resume with a fresh budget or end the
        investigation.
      </p>
      {state.phase === "resolved" ? (
        <p className="type-body" data-testid="continue-resolution">
          {state.decision === "continued" ? "Continued" : "Cancelled"}
        </p>
      ) : (
        <div className="flex gap-2">
          <DecisionButton
            size="sm"
            disabled={submitting}
            onClick={() => onResolve?.("approve")}
          >
            Continue
          </DecisionButton>
          <DecisionButton
            size="sm"
            variant="secondary"
            disabled={submitting}
            onClick={() => onResolve?.("reject")}
          >
            Cancel
          </DecisionButton>
        </div>
      )}
    </GateCard>
  );
}
