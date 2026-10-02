import type { ResolvedEvidence } from "@nightwarden/shared";
import { revealToolCall } from "@/features/session/transcript/revealToolCall";
import { targetOf } from "@/features/session/transcript/toolPresentation";

// A popping cobalt text link citing a tool call, revealing it in the
// transcript on click.
export function CitationChip({
  evidence,
}: {
  evidence: ResolvedEvidence;
}): React.JSX.Element {
  const target = targetOf(evidence.input);

  return (
    <button
      type="button"
      onClick={() => revealToolCall(evidence.toolCallId)}
      className="group inline-flex items-baseline gap-1 type-item text-accent-ink"
    >
      <span className="underline-offset-2 group-hover:underline">
        {evidence.toolName}
      </span>
      {target !== null && (
        <span className="type-small text-ink-muted">({target})</span>
      )}
    </button>
  );
}
