import { Card, CardContent } from "@/shared/ui/card";
import { cn } from "@/shared/lib/utils";
import { asRecord } from "@/shared/lib/toolResult";

export type DiffLineType = "added" | "removed" | "unchanged";
export interface DiffLine {
  type: DiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}
export interface DiffHunk {
  lines: DiffLine[];
}
interface FileChange {
  path: string;
  hunks: DiffHunk[];
}

// A result shaped like a file change, or nothing: a plain error string is not
// one, and neither is a tool that answered something else.
export function parseFileChange(result: unknown): FileChange | null {
  const record = asRecord(result);
  if (record === null) return null;
  if (typeof record["path"] !== "string" || !Array.isArray(record["hunks"])) {
    return null;
  }
  return { path: record["path"], hunks: record["hunks"] };
}

function lineClass(type: DiffLineType): string {
  if (type === "added") return "bg-ok-tint text-ok";
  if (type === "removed") return "bg-fail-tint text-fail";
  return "text-ink-base";
}

export function DiffCard({
  toolName,
  change,
}: {
  toolName: string;
  change: FileChange;
}): React.JSX.Element {
  const allLines = change.hunks.flatMap((hunk) => hunk.lines);
  const added = allLines.filter((l) => l.type === "added").length;
  const removed = allLines.filter((l) => l.type === "removed").length;

  return (
    <div data-testid="diff-card">
      <p className="mb-2 font-mono type-heading">
        {toolName}
        <span className="ml-2 text-ink-muted">{change.path}</span>
        <span className="ml-2 text-ok">+{added}</span>
        <span className="ml-1 text-fail">-{removed}</span>
      </p>
      <Card className="gap-3 py-3">
        <CardContent className="max-h-90 overflow-hidden px-0 font-mono type-prose">
          {change.hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex} className={hunkIndex > 0 ? "mt-3" : ""}>
              {hunk.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex gap-3 break-all whitespace-pre-wrap px-4",
                    lineClass(line.type),
                  )}
                >
                  <span className="w-8 shrink-0 select-none text-right text-ink-muted">
                    {line.oldLineNumber ?? ""}
                  </span>
                  <span className="w-8 shrink-0 select-none text-right text-ink-muted">
                    {line.newLineNumber ?? ""}
                  </span>
                  <span className="flex-1">
                    {line.content.length > 0 ? line.content : " "}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
