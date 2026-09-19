import type { RunnerRecord } from "@nightwarden/shared";
import { StatusText } from "@/shared/ui/status";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { timeAgo } from "@/shared/lib/time";
import { cn } from "@/shared/lib/utils";

// A summary line, not the whole advertised list: the count says the shape and
// the disclosure holds the keys for whoever needs one.
export function ServerCard({
  runner,
  actions,
  // The verify step exists to confirm the wiring, so it opens the list; a
  // managed fleet only needs the count until someone asks.
  defaultServicesOpen = false,
}: {
  runner: RunnerRecord;
  actions?: React.ReactNode;
  defaultServicesOpen?: boolean;
}): React.JSX.Element {
  const online = runner.online;
  const keys = (runner.manifest?.services ?? []).map((entry) => entry.target);

  return (
    <Card
      data-testid="server-card"
      data-offline={!runner.online || undefined}
      className={cn("gap-3 px-4 py-4", !runner.online && "opacity-60")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{runner.serverName}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {runner.hostname !== null && runner.hostname !== runner.serverName
              ? `host ${runner.hostname} · `
              : null}
            {runner.platform}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusText tone={online ? "ok" : "muted"}>
            {online ? "Online" : "Offline"}
          </StatusText>
          <span className="text-sm tabular-nums text-muted-foreground">
            {timeAgo(runner.lastSeen)}
          </span>
        </div>
      </div>

      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No services advertised yet.
        </p>
      ) : (
        <Collapsible
          defaultOpen={defaultServicesOpen}
          className="flex flex-col gap-2"
        >
          <CollapsibleTrigger
            render={<Button variant="link" className="self-start" />}
          >
            {keys.length} {keys.length === 1 ? "service" : "services"}
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-1">
            {keys.map((key) => (
              <span
                key={key}
                className="font-mono text-sm break-all text-muted-foreground"
              >
                {key}
              </span>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {actions !== undefined && (
        <div className="flex justify-end">{actions}</div>
      )}
    </Card>
  );
}
