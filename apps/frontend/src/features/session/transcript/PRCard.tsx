import { MetaText, StatusText } from "@/shared/ui/status";
import { Card, CardContent } from "@/shared/ui/card";
import { asRecord } from "@/shared/lib/toolResult";

interface PullRequestResult {
  action: "created" | "updated";
  number: number;
  url: string;
  draft: boolean;
  message?: string;
}

export function parsePullRequestResult(
  result: unknown,
): PullRequestResult | null {
  const record = asRecord(result);
  if (record === null) return null;
  if (
    (record["action"] !== "created" && record["action"] !== "updated") ||
    typeof record["number"] !== "number" ||
    typeof record["url"] !== "string"
  ) {
    return null;
  }
  return {
    action: record["action"],
    number: record["number"],
    url: record["url"],
    draft: record["draft"] === true,
    ...(typeof record["message"] === "string" && {
      message: record["message"],
    }),
  };
}

export function PRCard({ pr }: { pr: PullRequestResult }): React.JSX.Element {
  return (
    <div data-testid="pr-card">
      <p className="mb-2 font-mono type-heading">OpenPullRequest</p>
      <Card className="gap-3 py-3">
        <CardContent className="flex flex-wrap items-center gap-2 px-4">
          <span className="type-heading">Pull request #{pr.number}</span>
          <StatusText tone={pr.draft ? "muted" : "ok"}>
            {pr.draft ? "Draft" : "Open"}
          </StatusText>
          <MetaText>{pr.action}</MetaText>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto type-heading link external"
          >
            View on GitHub
          </a>
        </CardContent>
        {pr.message !== undefined && (
          <CardContent className="px-4">
            <p className="type-prose text-ink-muted">{pr.message}</p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
