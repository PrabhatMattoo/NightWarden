import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, PanelLeft } from "lucide-react";

import { Button, buttonVariants } from "@/shared/ui/button";
import { useSidebar } from "@/shared/ui/sidebar";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/shared/ui/breadcrumb";
import { cn } from "@/shared/lib/utils";

// A class as well as a component, because a few of these label something that
// is not a section and must not be a heading.
export const SECTION_HEADING = "text-sm font-medium text-muted-foreground";

/* A section's name, and what the section is for. The lead is where the general
   case is said once, so no field below has to carry it as well as its own. */
export function SectionHeading({
  lead,
  className,
  children,
}: {
  lead?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <h2 className={SECTION_HEADING}>{children}</h2>
      {lead !== undefined && (
        <p className="text-sm text-muted-foreground">{lead}</p>
      )}
    </div>
  );
}

/* One entry per level, root first. The last is where you are and never links;
   a lone entry is the page title, so the chevron appears only on descent. */
interface Crumb {
  label: string;
  to?: string;
}

/* `measure` names the page's own column from styles.css. "none" gives up the
   padding with it, for a report beside a rail. */
export function Page({
  crumbs,
  back,
  beside,
  controls,
  measure = "page",
  children,
}: {
  crumbs: Crumb[];
  // A back affordance in place of a breadcrumb trail, for a surface that keeps
  // the top bar but is one level down.
  back?: { to: string; label: string };
  /* Rides the crumbs rather than the far edge: a control that belongs to the
     thing named sits after its name, wherever that name happens to end. */
  beside?: React.ReactNode;
  controls?: React.ReactNode;
  measure?: "page" | "form" | "none";
  children?: React.ReactNode;
}): React.JSX.Element {
  const { isOverlay, openOverlay, toggleSidebar } = useSidebar();
  return (
    <div className="flex min-h-full w-full min-w-0 flex-col">
      {/* Padding rides the rows, not the bar, so the divider runs the full
          width of the stage. */}
      <header className="shrink-0">
        <div className="flex h-12 items-center gap-1 border-b border-border px-6 max-lg:px-4">
          {/* A panel that is fully off screen cannot host the control that
              reopens it, so the bar it left behind carries it instead. */}
          {isOverlay && !openOverlay && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle sidebar"
              aria-expanded={false}
              className="-ml-1 shrink-0 text-muted-foreground"
              onClick={() => toggleSidebar()}
            >
              <PanelLeft className="size-4.5" strokeWidth={1.5} aria-hidden />
            </Button>
          )}
          {back !== undefined && (
            <Link
              to={back.to}
              aria-label={`Back to ${back.label}`}
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon" }),
                "-ml-1 shrink-0 text-muted-foreground hover:bg-card-hover hover:text-foreground",
              )}
            >
              <ArrowLeft className="size-4.5" strokeWidth={1.5} aria-hidden />
            </Link>
          )}
          {/* The two header grammars are exclusive: a page that discloses the
              collection it belongs to says where it is that way instead. */}
          {crumbs.length > 0 && (
            <Breadcrumb className="min-w-0">
              {/* The ceiling a long title truncates against, so what sits beside
                it has somewhere to be. */}
              <BreadcrumbList className="max-w-title flex-nowrap text-sm font-medium">
                {crumbs.map((crumb, i) => (
                  <Fragment key={crumb.label}>
                    {i > 0 && <BreadcrumbSeparator />}
                    {/* Only the last crumb gives way. The ones before it name
                        the collection, and a collection cut to "Investi…" tells
                        the user less than the title it was protecting. */}
                    <BreadcrumbItem
                      className={
                        i === crumbs.length - 1 ? "min-w-0" : "shrink-0"
                      }
                    >
                      {/* font-medium beats the page part's own font-normal. */}
                      {crumb.to === undefined ? (
                        <BreadcrumbPage className="truncate font-medium">
                          {crumb.label}
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          className="whitespace-nowrap no-underline"
                          /* Exact, or an ancestor crumb claims aria-current
                           alongside the entry that really is the page. */
                          render={
                            <Link
                              to={crumb.to}
                              activeOptions={{ exact: true }}
                            />
                          }
                        >
                          {crumb.label}
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          )}
          {beside}
        </div>
        {/* Grouped, not a toolbar: the row also carries readouts. The size is
            set here so the whole bar reads at one step, whatever fills it. */}
        {controls !== undefined && (
          <div
            role="group"
            aria-label="Page controls"
            className="flex min-h-12 items-center justify-between gap-3 px-6 text-sm max-lg:px-4"
          >
            {controls}
          </div>
        )}
      </header>
      {measure === "none" ? (
        children
      ) : (
        <div
          className={cn(
            "flex w-full flex-1 flex-col p-6 max-lg:px-4",
            measure === "form" && "mx-auto max-w-narrow",
            measure === "page" && "mx-auto max-w-wide",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// The one description style, so every page's subtext reads at one size and tone.
export const DESCRIPTION = "text-sm text-muted-foreground";

const MEASURE_CLASS: Record<"wide" | "narrow", string> = {
  wide: "max-w-wide",
  narrow: "max-w-narrow",
};

// A fully-closed overlay rail leaves no control behind, so a page header carries
// the toggle that reopens it.
function OverlayToggle(): React.JSX.Element | null {
  const { isOverlay, openOverlay, toggleSidebar } = useSidebar();
  if (!isOverlay || openOverlay) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle sidebar"
      aria-expanded={false}
      className="-ml-1 shrink-0 text-muted-foreground"
      onClick={() => toggleSidebar()}
    >
      <PanelLeft className="size-4.5" strokeWidth={1.5} aria-hidden />
    </Button>
  );
}

/* A top-level destination: its title stands in the content column, so the page
   names itself rather than borrowing the breadcrumb bar a drill-in needs. */
export function SectionPage({
  title,
  description,
  actions,
  toolbar,
  measure = "wide",
  children,
}: {
  title: string;
  description?: string;
  // The right side of the title row: a search field, a primary action.
  actions?: React.ReactNode;
  // A second row under the title: filters, a view toggle.
  toolbar?: React.ReactNode;
  measure?: "wide" | "narrow";
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "mx-auto flex min-h-full w-full min-w-0 flex-col px-6 pt-16 pb-8 max-lg:px-4",
        MEASURE_CLASS[measure],
      )}
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <OverlayToggle />
          <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold tracking-title">
            {title}
          </h1>
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
        {description !== undefined && (
          <p className={cn("m-0", DESCRIPTION)}>{description}</p>
        )}
        {toolbar !== undefined && (
          <div className="mt-3 flex items-center gap-3">{toolbar}</div>
        )}
      </header>
      <div className="mt-6 flex-1">{children}</div>
    </div>
  );
}

/* A drill-in from a section: a back link stands where a top-level page puts its
   title, so returning is one click and the parent is named. */
export function DetailPage({
  back,
  actions,
  measure = "narrow",
  children,
}: {
  back: { to: string; label: string };
  actions?: React.ReactNode;
  measure?: "wide" | "narrow";
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-full w-full min-w-0 flex-col">
      {/* Top-left, level with the rail's own toggle: one way back, unmissable. */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-3 max-lg:px-2">
        <OverlayToggle />
        <Link
          to={back.to}
          aria-label={`Back to ${back.label}`}
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "gap-2 text-muted-foreground hover:bg-card-hover hover:text-foreground",
          )}
        >
          <ArrowLeft aria-hidden />
          {back.label}
        </Link>
        {actions !== undefined && (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        )}
      </header>
      <div
        className={cn(
          "mx-auto flex w-full flex-1 flex-col px-6 pt-4 pb-8 max-lg:px-4",
          MEASURE_CLASS[measure],
        )}
      >
        {children}
      </div>
    </div>
  );
}
