import { Fragment, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ListFilter, Telescope } from "lucide-react";
import type { SessionListRow, StatusFilter } from "@nightwarden/shared";
import { STATUS_FILTERS } from "@nightwarden/shared";

import { Page } from "@/shared/ui/Page";
import { Button, buttonVariants } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Rounds } from "@/shared/ui/Rounds";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/shared/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/shared/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { useCan } from "@/features/auth/useCan";
import { useFrontendEvents } from "@/shared/events/FrontendEventsProvider";
import { useSessions } from "@/features/session/useSessions";
import { sessionsQueryKey } from "@/features/session/queries";
import {
  FILTER_LABEL,
  groupByStatus,
  STATUS_LABEL,
} from "@/features/investigations/queue";
import { api, dataOrThrow } from "@/shared/api/client";
import { timeAgo } from "@/shared/lib/time";
import { toast } from "@/shared/lib/toast";
import { cn } from "@/shared/lib/utils";

/* Colour answers one question per hue: is a person holding this up, did the
   condition stop firing, did the run break. Everything else is ink. */
function statusLineTone(row: SessionListRow): string {
  if (row.awaitingHumanInput) return "text-warn";
  if (row.status === "resolved") return "text-ok";
  if (row.status === "failed") return "text-fail";
  return "text-ink-muted";
}

// What the hourly limit held runs only when a person says so.
function StartButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/sessions/{id}/start", {
          params: { path: { id: sessionId } },
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: sessionsQueryKey("investigation"),
      }),
    onError: (err) => {
      toast.show({
        title: "Could not start the investigation",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={start.isPending}
      onClick={() => start.mutate()}
    >
      Start
    </Button>
  );
}

// The severity word is the user's own and never matched against a list, so a
// fleet labelling alerts P1 reads as one labelling them critical.
function InvestigationRow({ row }: { row: SessionListRow }): React.JSX.Element {
  const canRun = useCan({ session: ["run"] });
  // Read from the row's own status, so it says a run is moving at this moment.
  const running = row.status === "running";
  // A held row carries a button, which a link cannot hold, so only its title links.
  const held = row.status === "not_started";
  const title = <span className="min-w-0 truncate">{row.title}</span>;
  const body = (
    <>
      <ItemContent>
        <ItemTitle>
          {held ? (
            <Link to="/investigations/$id" params={{ id: row.sessionId }}>
              {title}
            </Link>
          ) : (
            title
          )}
        </ItemTitle>
        {(row.statusLine !== null || running) && (
          <ItemDescription>
            <span
              className={cn(
                "flex min-w-0 items-center gap-2",
                statusLineTone(row),
              )}
            >
              <span className="min-w-0 truncate">{row.statusLine}</span>
              {running && <Rounds size="inline" />}
            </span>
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        {row.severityLabel !== null && (
          <span className="type-body text-ink-muted">{row.severityLabel}</span>
        )}
        {/* When it last moved, not when it opened: on a run parked for your
            answer, that is how long it has been waiting. */}
        <span className="w-9 text-right type-body tabular-nums text-ink-muted">
          {timeAgo(row.lastActivityAt)}
        </span>
        {held && canRun && <StartButton sessionId={row.sessionId} />}
      </ItemActions>
    </>
  );
  return held ? (
    <Item>{body}</Item>
  ) : (
    <Item
      render={<Link to="/investigations/$id" params={{ id: row.sessionId }} />}
      className="no-underline"
    >
      {body}
    </Item>
  );
}

// Rows share one card, each ruled from the next edge to edge.
function RowCard({ rows }: { rows: SessionListRow[] }): React.JSX.Element {
  return (
    <Card>
      <ItemGroup>
        {rows.map((row, i) => (
          <Fragment key={row.sessionId}>
            {i > 0 && <ItemSeparator />}
            <InvestigationRow row={row} />
          </Fragment>
        ))}
      </ItemGroup>
    </Card>
  );
}

type Shown = StatusFilter | "all";

// Why the view is empty, said plainly; the filters each name what they would hold.
const NOTHING: Record<Shown, { title: string; description: string }> = {
  all: {
    title: "No investigations yet",
    description:
      "NightWarden opens one on its own the moment a connected alert source sends an alert.",
  },
  active: {
    title: "Nothing is active",
    description:
      "No investigation is running, waiting on an approval or an answer, or waiting to be started.",
  },
  resolved: {
    title: "No resolved investigations",
    description: "No alert behind an investigation has cleared yet.",
  },
  closed: {
    title: "No closed investigations",
    description: "No investigation has finished, been stopped or failed yet.",
  },
};

/* A first visit is pointed at what starts an investigation; an empty filter is
   handed back the whole list, so it is never a dead end. */
function Nothing({
  shown,
  onShowAll,
}: {
  shown: Shown;
  onShowAll: () => void;
}): React.JSX.Element {
  const first = shown === "all";
  const canConnect = useCan({ integration: ["manage"] });
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia>{first ? <Telescope /> : <ListFilter />}</EmptyMedia>
        <EmptyTitle>{NOTHING[shown].title}</EmptyTitle>
        <EmptyDescription>{NOTHING[shown].description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {!first ? (
          <Button variant="secondary" size="sm" onClick={onShowAll}>
            Show all investigations
          </Button>
        ) : (
          canConnect && (
            <Link
              to="/integrations"
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              Connect alerting
            </Link>
          )
        )}
      </EmptyContent>
    </Empty>
  );
}

const SHOWN: readonly Shown[] = ["all", ...STATUS_FILTERS];

export function InvestigationsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<Shown>("all");
  const { sessions, isLoading, hasMore, isLoadingMore, loadMore } = useSessions(
    "investigation",
    shown === "all" ? {} : { status: shown },
  );

  useFrontendEvents((env) => {
    // Status is server-derived, so anything that can change it refetches the
    // authoritative lists rather than being patched into the cache here.
    if (
      env.type === "SESSION_OPENED" ||
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

  return (
    <Page
      title="Investigations"
      subtitle="Every investigation NightWarden has opened, grouped by what each one needs."
      toolbar={
        <ToggleGroup
          variant="pills"
          aria-label="Show investigations"
          value={[shown]}
          onValueChange={(next) => {
            const picked = SHOWN.find((filter) => filter === next[0]);
            // Pressing the chosen one again empties the group; the choice stays.
            if (picked !== undefined) setShown(picked);
          }}
        >
          {SHOWN.map((filter) => (
            <ToggleGroupItem key={filter} value={filter}>
              {filter === "all" ? "All" : FILTER_LABEL[filter]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      {!isLoading && sessions.length === 0 ? (
        <Nothing shown={shown} onShowAll={() => setShown("all")} />
      ) : (
        <>
          {shown === "all" ? (
            // Space separates the groups; there is no rule and no column header.
            <div className="flex flex-col gap-6">
              {groupByStatus(sessions).map((group) => (
                <section
                  key={group.status}
                  aria-label={STATUS_LABEL[group.status]}
                >
                  <h2 className="mb-3 type-heading">
                    {STATUS_LABEL[group.status]}
                  </h2>
                  <RowCard rows={group.rows} />
                </section>
              ))}
            </div>
          ) : (
            <RowCard rows={sessions} />
          )}
          {hasMore && (
            <Button
              variant="quiet"
              size="sm"
              className="mt-6 self-start"
              disabled={isLoadingMore}
              onClick={loadMore}
            >
              Load older investigations
            </Button>
          )}
        </>
      )}
    </Page>
  );
}
