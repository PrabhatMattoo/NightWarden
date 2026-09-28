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
      className="gap-3 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="type-item">{runner.serverName}</p>
          <p className="mt-1 type-body text-ink-muted">
            {runner.hostname !== null && runner.hostname !== runner.serverName
              ? `host ${runner.hostname} · `
              : null}
            {runner.platform}
          </p>
        </div>
        {/* Offline is something to act on, so it says how long it has been. */}
        {online ? (
          <StatusText tone="ok">Online</StatusText>
        ) : (
          <StatusText tone="warn">
            Offline · last seen {timeAgo(runner.lastSeen)} ago
          </StatusText>
        )}
      </div>

      {keys.length === 0 ? (
        <p className="type-body text-ink-muted">No services advertised yet.</p>
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
                className="font-mono type-body break-all text-ink-muted"
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
