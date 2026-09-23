import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRight,
  RotateCcw,
  Trash2,
} from "lucide-react";

import { Page } from "@/shared/ui/Page";
import { SessionView } from "@/features/session/SessionView";
import { ReportPanel } from "@/features/report/ReportPanel";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useSession } from "@/features/session/useSession";
import { useSessionDeletion } from "@/features/session/useSessionDeletion";
import { useSessionReport } from "@/features/report/useSessionReport";
import { useSessions } from "@/features/session/useSessions";
import { investigationQueue } from "@/features/investigations/queue";
import { ICON_UI } from "@/shared/lib/iconProps";
import { reportToMarkdown } from "@/features/report/reportMarkdown";
import { toast } from "@/shared/lib/toast";
import { readStoredNumber, writeStoredNumber } from "@/shared/lib/persisted";
import { cssNumber } from "@/shared/lib/cssNumber";
import { cn } from "@/shared/lib/utils";
import { apiFetch } from "@/shared/api/client";
import { onReveal } from "@/features/session/transcript/revealToolCall";

// A question about the reader's screen, not this layout, so the width they set
// on the report panel outlives the session.
const WIDTH_KEY = "nightwarden.report.width";

function clampWidth(width: number): number {
  const min = cssNumber("--container-rail", 480);
  const max = cssNumber("--container-rail-max", 720);
  return Math.min(max, Math.max(min, Math.round(width)));
}

// So triage moves record to record without returning to the list. The order
// is the list's own and the total the server's, so the two cannot disagree.
function QueueStepper({
  sessionId,
}: {
  sessionId: string;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const { sessions, investigationTotal } = useSessions("investigation");
  const queue = investigationQueue(sessions);
  const at = queue.findIndex((row) => row.sessionId === sessionId);
  // A session the list has not placed yet - a promotion a moment ago - claims
  // no position rather than a wrong one.
  if (at === -1) return null;

  const step = (to: number): void => {
    const target = queue[to];
    if (target !== undefined) {
      void navigate({
        to: "/investigations/$id",
        params: { id: target.sessionId },
      });
    }
  };

  return (
    <>
      <span className="type-body tabular-nums text-ink-muted">
        {at + 1} / {investigationTotal}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous investigation"
        disabled={at === 0}
        onClick={() => step(at - 1)}
      >
        <ChevronLeft {...ICON_UI} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next investigation"
        disabled={at >= queue.length - 1}
        onClick={() => step(at + 1)}
      >
        <ChevronRight {...ICON_UI} />
      </Button>
    </>
  );
}

// The conversation holds the centre and never moves; the report opens beside it.
// No "Mark as resolved" in the menu: status is derived and never declared.
export function InvestigationWorkspace(): React.JSX.Element {
  const { id } = useParams({ strict: false });
  const sessionId = id ?? "";
  const session = useSession(sessionId === "" ? null : sessionId);
  const report = useSessionReport(sessionId === "" ? null : sessionId);
  const title = session?.title ?? "";
  const deletion = useSessionDeletion({
    sessionId,
    kind: "investigation",
    noun: "investigation",
    title,
    returnTo: "/investigations",
  });

  const running = session?.running ?? false;
  const reportReady = (report?.record?.report ?? null) !== null;

  const [reportOpen, setReportOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [width, setWidth] = useState(() =>
    clampWidth(readStoredNumber(WIDTH_KEY, cssNumber("--container-rail", 480))),
  );
  const [dragging, setDragging] = useState(false);

  // A settled investigation opens beside the chat, and a run that finishes opens
  // the report it just filled. A person can still close it and it stays closed.
  const prevRunning = useRef<boolean | null>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (session === null) return;
    if (!initialized.current) {
      initialized.current = true;
      prevRunning.current = running;
      if (!running && reportReady) setReportOpen(true);
      return;
    }
    if (prevRunning.current === true && !running && reportReady) {
      setReportOpen(true);
    }
    prevRunning.current = running;
  }, [session, running, reportReady]);

  const asideRef = useRef<HTMLElement>(null);
  const beginDrag = (event: React.PointerEvent): void => {
    const aside = asideRef.current;
    if (aside === null || event.button !== 0) return;
    event.preventDefault();
    const edge = aside.getBoundingClientRect().right;
    setDragging(true);

    let latest = width;
    const move = (moved: PointerEvent): void => {
      latest = clampWidth(edge - moved.clientX);
      setWidth(latest);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setDragging(false);
      writeStoredNumber(WIDTH_KEY, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const nudge = (by: number): void => {
    const next = clampWidth(width + by);
    setWidth(next);
    writeStoredNumber(WIDTH_KEY, next);
  };

  const copyMarkdown = (): void => {
    void navigator.clipboard
      .writeText(reportToMarkdown(title, session?.alerts ?? [], report ?? null))
      .then(() => toast.show({ message: "Report copied as Markdown" }))
      .catch(() =>
        toast.show({ message: "Could not copy the report", variant: "error" }),
      );
  };

  // Reopening returns a closed investigation to testing with its record intact;
  // the run itself revises the report from what it finds.
  const reopen = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/sessions/${sessionId}/reopen`, { method: "POST" }),
    onError: (err) =>
      toast.show({
        title: "Could not reopen the investigation",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const canReopen = reportReady && !running;

  // Revealing a cited tool from the report turns off full screen so the
  // transcript is visible beside it.
  useEffect(() => {
    return onReveal(() => {
      setMaximized(false);
    });
  }, []);

  const closeReport = (): void => {
    setReportOpen(false);
    setMaximized(false);
  };

  const step = cssNumber("--container-rail-step", 20);

  return (
    <Page
      crumbs={[{ label: title }]}
      back={{ to: "/investigations", label: "Investigations" }}
      measure="full"
      beside={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="quiet"
                  size="icon-sm"
                  aria-label="More actions"
                  className="ml-1 shrink-0"
                >
                  <MoreHorizontal {...ICON_UI} />
                </Button>
              }
            />
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={copyMarkdown}>
                <ClipboardCopy {...ICON_UI} />
                Copy report as Markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={deletion.confirm}>
                <Trash2 {...ICON_UI} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {canReopen && (
              <Button
                variant="default"
                size="sm"
                disabled={reopen.isPending}
                onClick={() => reopen.mutate()}
              >
                <RotateCcw {...ICON_UI} />
                Reopen investigation
              </Button>
            )}
            <QueueStepper sessionId={sessionId} />
            {/* A gap separates this pair from the stepper, which moves between
                records rather than reshaping the one on screen. */}
            {reportOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="ml-3"
                aria-label={
                  maximized ? "Restore the report" : "Maximize the report"
                }
                onClick={() => setMaximized((prev) => !prev)}
              >
                {maximized ? (
                  <Minimize2 {...ICON_UI} />
                ) : (
                  <Maximize2 {...ICON_UI} />
                )}
              </Button>
            )}
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={reportOpen ? "Hide the report" : "Show the report"}
              aria-expanded={reportOpen}
              className={cn(!reportOpen && "ml-3")}
              onClick={() => (reportOpen ? closeReport() : setReportOpen(true))}
            >
              <PanelRight {...ICON_UI} />
            </Button>
          </div>
        </>
      }
    >
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Always mounted, so a run keeps streaming while the report is read;
            hidden rather than removed when the report takes the whole stage. */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            maximized && "hidden",
          )}
        >
          <SessionView
            sessionId={sessionId === "" ? null : sessionId}
            reportOpen={reportOpen}
          />
        </div>
        <aside
          ref={asideRef}
          aria-label="Investigation report"
          aria-hidden={!reportOpen}
          inert={!reportOpen}
          // The dragged width travels as a variable, so the classes below still own the layout.
          style={{ "--rail-width": `${width}px` }}
          className={cn(
            "relative flex flex-col overflow-hidden border-l-hairline",
            dragging
              ? "transition-none"
              : "transition-layout duration-(--duration-panel) ease-panel",
            !reportOpen && "w-0 shrink-0 border-transparent",
            reportOpen && !maximized && "w-(--rail-width) shrink-0 border-edge",
            reportOpen && maximized && "flex-1 border-edge",
          )}
        >
          {reportOpen && !maximized && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the report"
              aria-valuenow={width}
              aria-valuemin={cssNumber("--container-rail", 480)}
              aria-valuemax={cssNumber("--container-rail-max", 720)}
              tabIndex={0}
              onPointerDown={beginDrag}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                nudge(event.key === "ArrowLeft" ? step : -step);
              }}
              className="absolute inset-y-0 left-0 z-(--z-rail-grip) w-3 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-0.5 hover:after:bg-edge-strong focus-visible:after:bg-edge-strong"
            />
          )}
          {/* The content holds its own width while the panel narrows past it, so
              nothing inside reflows on the way closed. */}
          <div
            className={cn(
              "flex min-h-0 flex-1 shrink-0 flex-col overflow-y-auto transition-opacity duration-(--duration-fast)",
              maximized ? "w-full" : "w-(--rail-width)",
              reportOpen
                ? "opacity-100 delay-(--duration-base)"
                : "opacity-0 delay-0",
            )}
          >
            <ReportPanel
              record={report?.record ?? null}
              decisions={report?.decisions ?? []}
              evidence={report?.evidence ?? []}
              alerts={session?.alerts ?? []}
              createdAt={session?.createdAt ?? null}
              lastActivityAt={session?.lastActivityAt ?? null}
            />
          </div>
        </aside>
      </div>
      {deletion.dialog}
    </Page>
  );
}
