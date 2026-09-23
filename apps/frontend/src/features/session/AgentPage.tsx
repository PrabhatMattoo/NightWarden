import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  ChevronDown,
  ClipboardCopy,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";

import { Page } from "@/shared/ui/Page";
import { SessionView } from "@/features/session/SessionView";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Separator } from "@/shared/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { useSession } from "@/features/session/useSession";
import { useSessionDeletion } from "@/features/session/useSessionDeletion";
import { useSessions } from "@/features/session/useSessions";
import { chatToMarkdown } from "@/features/session/chatMarkdown";
import { ICON_UI } from "@/shared/lib/iconProps";
import { DAY_GROUPS, dayGroup, timeAgo } from "@/shared/lib/time";
import { toast } from "@/shared/lib/toast";

// A session is what it is from the moment it exists, so the kind filter is
// the whole rule and no row ever leaves this list.
function ChatHistory({ onLeave }: { onLeave: () => void }): React.JSX.Element {
  const { sessions, isLoading, hasMore, isLoadingMore, loadMore } =
    useSessions("chat");

  const groups = DAY_GROUPS.map((group) => ({
    group,
    rows: sessions.filter((row) => dayGroup(row.lastActivityAt) === group),
  })).filter((entry) => entry.rows.length > 0);

  return (
    <>
      {!isLoading && groups.length === 0 && (
        <p className="m-0 px-2.5 py-1 type-body text-ink-muted">No history</p>
      )}
      {groups.map(({ group, rows }, index) => (
        <section key={group} aria-label={group} className="flex flex-col">
          {/* Every division in this panel is drawn the same way and spaced the
              same, so the New chat entry and one day against the next read as
              one rhythm rather than two. */}
          {index > 0 && <Separator className="my-1" />}
          {/* A day, written the way it is said. The uppercase mono label is for
              naming a system's own parts, which a Tuesday is not. */}
          <h3 className="m-0 px-2.5 py-1 type-body text-ink-muted">{group}</h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => (
              <li key={row.sessionId}>
                <Link
                  to="/agent/$id"
                  params={{ id: row.sessionId }}
                  onClick={onLeave}
                  className="flex items-center justify-between gap-3 rounded-control px-2.5 py-1.5 type-body no-underline transition-colors hover:bg-hover"
                >
                  <span className="min-w-0 truncate">{row.title}</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    {timeAgo(row.lastActivityAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {hasMore && (
        <Button
          variant="quiet"
          size="sm"
          className="self-start"
          disabled={isLoadingMore}
          onClick={loadMore}
        >
          {isLoadingMore ? "Loading…" : "Load older conversations"}
        </Button>
      )}
    </>
  );
}

// The conversation runs the full stage, so this page has no measured body:
// everything it offers rides the crumb.
export function AgentPage(): React.JSX.Element {
  const { id } = useParams({ strict: false });
  const sessionId = id ?? null;
  const session = useSession(sessionId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const title = session?.title ?? "New chat";
  const deletion = useSessionDeletion({
    sessionId,
    kind: "chat",
    noun: "chat",
    title,
    returnTo: "/agent",
  });

  const copyMarkdown = (): void => {
    void navigator.clipboard
      .writeText(chatToMarkdown(title, session?.transcript ?? []))
      .then(() => toast.show({ message: "Chat copied as Markdown" }))
      .catch(() =>
        toast.show({ message: "Could not copy the chat", variant: "error" }),
      );
  };

  return (
    <Page
      crumbs={[]}
      measure="full"
      beside={
        <div className="flex min-w-0 items-center gap-1">
          <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
            {/* Name and chevron are one target: the disclosure is the name,
                not a control standing next to it. */}
            <PopoverTrigger
              render={
                <Button variant="ghost" size="sm" className="max-w-title">
                  <span className="min-w-0 truncate">{title}</span>
                  <ChevronDown
                    strokeWidth={1.75}
                    aria-hidden
                    className="shrink-0 text-ink-muted"
                  />
                </Button>
              }
            />
            {/* Under the whole disclosure, not centred on it: the panel opens
                from the name it belongs to. */}
            <PopoverContent align="start" className="gap-0">
              {/* Only once there is something to start afresh from, and above
                  the list because it is an action rather than one of its rows. */}
              {sessionId !== null && (
                <>
                  <Link
                    to="/agent"
                    onClick={() => setHistoryOpen(false)}
                    className="flex items-center gap-2 rounded-control px-2.5 py-1.5 type-body no-underline transition-colors hover:bg-hover"
                  >
                    <Plus {...ICON_UI} />
                    New chat
                  </Link>
                  <Separator className="my-1" />
                </>
              )}
              <ChatHistory onLeave={() => setHistoryOpen(false)} />
            </PopoverContent>
          </Popover>

          {sessionId !== null && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label="More actions"
                  >
                    <MoreHorizontal {...ICON_UI} />
                  </Button>
                }
              />
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={copyMarkdown}>
                  <ClipboardCopy {...ICON_UI} />
                  Copy as Markdown
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* The API refuses this while a run holds the session, so the
                    menu says so rather than offering an error. */}
                <DropdownMenuItem
                  disabled={session?.running === true}
                  onClick={deletion.confirm}
                >
                  <Trash2 {...ICON_UI} />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      {/* The fall belongs to this surface alone, where the conversation has the
          whole stage to fall through. */}
      <div className="stage-fall flex min-h-0 flex-1 flex-col overflow-hidden">
        <SessionView sessionId={sessionId} />
      </div>
      {deletion.dialog}
    </Page>
  );
}
