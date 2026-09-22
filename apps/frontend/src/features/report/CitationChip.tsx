import type { NormalizedAlert, ResolvedEvidence } from "@nightwarden/shared";
import { revealToolCall } from "@/features/session/transcript/revealToolCall";
import { targetOf } from "@/features/session/transcript/toolPresentation";

// A popping cobalt text link citing a tool call, revealing it in the
// transcript on click.
export function CitationChip({
  evidence,
}: {
  evidence: ResolvedEvidence;
  alert?: NormalizedAlert | null;
}): React.JSX.Element {
  const target = targetOf(evidence.input);

  return (
    <button
      type="button"
      onClick={() => revealToolCall(evidence.toolCallId)}
      className="group inline-flex items-baseline gap-1 text-sm font-medium text-primary-ink"
    >
      <span className="underline-offset-2 group-hover:underline">
        {evidence.toolName}
      </span>
      {target !== null && (
        <span className="text-xs font-normal text-muted-foreground">
          ({target})
        </span>
      )}
    </button>
  );
}
