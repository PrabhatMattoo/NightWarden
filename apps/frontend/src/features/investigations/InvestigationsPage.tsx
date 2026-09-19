import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ListFilter, Telescope } from "lucide-react";
import type {
  InvestigationStatus,
  QueueState,
  SessionListRow,
} from "@nightwarden/shared";

import { SectionPage, SECTION_HEADING } from "@/shared/ui/Page";
import { Button, buttonVariants } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Spinner } from "@/shared/ui/spinner";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/shared/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { useFrontendEvents } from "@/shared/events/FrontendEventsProvider";
import {
  renameSession,
  sessionsQueryKey,
  useSessions,
} from "@/features/session/useSessions";
import { groupByStatus, STATUS_LABEL } from "@/features/investigations/queue";
import { timeAgo } from "@/shared/lib/time";
import { cn } from "@/shared/lib/utils";

/* Colour answers one question per hue: is a person holding this up, did the
   condition stop firing, did the run break. Everything else is ink. */
function statusLineTone(row: SessionListRow): string {
  if (row.awaitingHumanInput) return "text-wait";
  if (row.status === "resolved") return "text-ok";
  if (row.status === "failed") return "text-fail";
  return "text-muted-foreground";
}

// The severity word is the user's own and never matched against a list, so a
// fleet labelling alerts P1 reads as one labelling them critical.
function InvestigationRow({
  row,
  running,
}: {
  row: SessionListRow;
  running: boolean;
}): React.JSX.Element {
  return (
    <li className="not-last:border-b not-last:border-border">
      <Link
        to="/investigations/$id"
        params={{ id: row.sessionId }}
        // Stitched into the group card, so hover moves the fill and nothing else.
        className="flex flex-col gap-1 px-4 py-3 no-underline transition-colors hover:bg-card-hover"
      >
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-medium">
            {row.title}
          </span>
          {row.severityLabel !== null && (
            <span className="min-w-0 shrink truncate text-sm text-ink-subtle">
              {row.severityLabel}
            </span>
          )}
          {/* When it last moved, not when it opened: on a run parked for your
              answer, that is how long it has been waiting. */}
          <span className="w-9 shrink-0 text-right text-sm tabular-nums text-ink-subtle">
            {timeAgo(row.lastActivityAt)}
          </span>
        </span>

        {(row.statusLine !== null || running) && (
          <span className="flex items-baseline gap-3">
            <span
              className={cn("min-w-0 flex-1 truncate", statusLineTone(row))}
            >
              {row.statusLine}
            </span>
            {/* Read from the live dispatcher, so it is not decoration: it says
                a run is moving at this moment. */}
            {running && (
              <Spinner
                aria-hidden
                role="none"
                className="size-3.5 shrink-0 self-center text-run"
              />
            )}
          </span>
        )}
      </Link>
    </li>
  );
}

// Waiting alerts are not sessions, so not rows. No colour either: nobody is
// holding this up, the fleet is at a limit the reader can raise.
function QueueBand({
  queue,
}: {
  queue: QueueState | null;
}): React.JSX.Element | null {
  if (queue === null || queue.waiting === 0) return null;
  const alerts = queue.waiting === 1 ? "1 alert" : `${queue.waiting} alerts`;
  return (
    <p className="mb-6 flex items-center gap-2 text-sm">
      <Spinner aria-hidden className="size-3.5 text-run" role="none" />
      <span className="font-medium">{alerts} waiting</span>
      <span className="text-muted-foreground">
        {queue.running} of {queue.limit} investigations running
        {queue.oldestArrivedAt !== null &&
          ` · oldest waiting ${timeAgo(queue.oldestArrivedAt)}`}
      </span>
    </p>
  );
}

// The first state of every fresh install: no alert has arrived, so the panel
// points at the one thing that changes that.
function NothingYet(): React.JSX.Element {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Telescope aria-hidden strokeWidth={1.5} />
        </EmptyMedia>
        <EmptyTitle>No investigations yet</EmptyTitle>
        <EmptyDescription>
          One opens when an alert arrives from a connected source. Connect your
          alerting to start.
        </EmptyDescription>
      </EmptyHeader>
      <Link to="/integrations" className={buttonVariants()}>
        Connect an alert source
      </Link>
    </Empty>
  );
}

type StatusFilter = InvestigationStatus | "all";

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All",
  action_required: STATUS_LABEL.action_required,
  running: STATUS_LABEL.running,
  resolved: STATUS_LABEL.resolved,
  completed: STATUS_LABEL.completed,
  stopped: STATUS_LABEL.stopped,
  failed: STATUS_LABEL.failed,
};

export function InvestigationsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const {
    sessions,
    isLoading,
    hasMore,
    isLoadingMore,
    loadMore,
    queue: fetched,
  } = useSessions("investigation");
  // Null until an event lands, and the fetch stands in: a reload receives no
  // event, so without it the band is blank while alerts wait.
  const [pushed, setPushed] = useState<QueueState | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const queue = pushed ?? fetched;

  useFrontendEvents((env) => {
    if (env.type === "QUEUE_CHANGED") {
      setPushed(env.payload);
      return;
    }
    if (env.type === "SESSION_TITLE_UPDATED") {
      const { sessionId, title } = env.payload;
      renameSession(queryClient, "investigation", sessionId, title);
      return;
    }
    // Status is server-derived, so anything that can change it refetches the
    // authoritative list rather than being patched into the cache here.
    if (
      env.type === "REPORT_UPDATED" ||
      env.type === "RUN_FINISHED" ||
      env.type === "RUN_STOPPED" ||
      env.type === "RUN_FAILED" ||
      env.type === "HUMAN_INPUT_REQUIRED" ||
      env.type === "HUMAN_INPUT_RESOLVED"
    ) {
      void queryClient.invalidateQueries({
        queryKey: sessionsQueryKey("investigation"),
      });
    }
  });

  const groups = groupByStatus(sessions).filter(
    (group) => status === "all" || group.status === status,
  );

  return (
    <SectionPage
      title="Investigations"
      description="Every investigation NightWarden has opened, grouped by what each one needs."
      toolbar={
        <Select
          items={FILTER_LABEL}
          value={status}
          onValueChange={(value) => setStatus(value as StatusFilter)}
        >
          <SelectTrigger aria-label="Filter by status" className="w-44">
            <ListFilter
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(FILTER_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {!isLoading && groups.length === 0 ? (
        status !== "all" ? (
          <p className="py-8 text-sm text-muted-foreground">
            No investigations match.
          </p>
        ) : (
          <NothingYet />
        )
      ) : (
        <>
          <QueueBand queue={queue} />
          {/* Space separates the groups; there is no rule and no column header. */}
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section
                key={group.status}
                aria-label={STATUS_LABEL[group.status]}
              >
                <h2 className={cn("mb-2 px-1", SECTION_HEADING)}>
                  {STATUS_LABEL[group.status]}
                </h2>
                <Card className="gap-0 py-0">
                  <ul className="m-0 flex list-none flex-col p-0">
                    {group.rows.map((row) => (
                      <InvestigationRow
                        key={row.sessionId}
                        row={row}
                        running={group.status === "running"}
                      />
                    ))}
                  </ul>
                </Card>
              </section>
            ))}
          </div>
          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-6 self-start text-muted-foreground"
              disabled={isLoadingMore}
              onClick={loadMore}
            >
              {isLoadingMore ? "Loading…" : "Load older investigations"}
            </Button>
          )}
        </>
      )}
    </SectionPage>
  );
}
