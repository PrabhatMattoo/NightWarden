import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { buttonVariants } from "@/shared/ui/button";
import { SidebarTrigger, useSidebar } from "@/shared/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/shared/ui/breadcrumb";
import { cn } from "@/shared/lib/utils";

interface Crumb {
  label: string;
  to?: string;
}

/* The row above a page: a way back, where the page sits, and what acts on it.
   Below lg it also carries the toggle the hidden rail left behind. */
interface Bar {
  back?: { to: string; label: string };
  crumbs?: Crumb[];
  // Rides the crumbs: a control that belongs to the thing named sits after it.
  beside?: React.ReactNode;
  controls?: React.ReactNode;
}

// Two widths: the reading column, and a wider one for pages that list or lay out a grid.
const MEASURE = {
  page: "max-w-page",
  wide: "max-w-page-wide",
} as const;

// A bar over a full-width workspace is ruled off from it.
function PageBar({
  back,
  crumbs,
  beside,
  controls,
  ruled,
}: Bar & { ruled: boolean }): React.JSX.Element {
  const { isOverlay } = useSidebar();
  const trail = crumbs !== undefined && crumbs.length > 0;
  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center gap-1 px-3 sm:px-4",
        ruled && "border-b-hairline border-edge-faint",
      )}
    >
      {isOverlay && <SidebarTrigger className="shrink-0" />}
      {back !== undefined && (
        <Link
          to={back.to}
          aria-label={`Back to ${back.label}`}
          className={cn(
            buttonVariants({
              variant: "ghost",
              size: trail ? "icon-sm" : "sm",
            }),
            "shrink-0 text-ink-muted hover:text-ink-title",
          )}
        >
          <ChevronLeft aria-hidden />
          {!trail && back.label}
        </Link>
      )}
      {trail && (
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="max-w-title flex-nowrap">
            {crumbs.map((crumb, i) => (
              <Fragment key={crumb.label}>
                {i > 0 && <BreadcrumbSeparator />}
                {/* Only the last gives way: a collection cut short names less
                    than the title it was protecting. */}
                <BreadcrumbItem
                  className={i === crumbs.length - 1 ? "min-w-0" : "shrink-0"}
                >
                  {crumb.to === undefined ? (
                    <BreadcrumbPage className="truncate">
                      {crumb.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      className="whitespace-nowrap no-underline"
                      render={
                        <Link to={crumb.to} activeOptions={{ exact: true }} />
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
      {controls !== undefined && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {controls}
        </div>
      )}
    </header>
  );
}

/* One frame for every page: a bar when there is a way back or a hidden rail,
   a titled column for a destination, or the whole stage for a workspace. */
export function Page({
  back,
  crumbs,
  beside,
  controls,
  title,
  subtitle,
  actions,
  toolbar,
  measure = "page",
  children,
}: Bar & {
  title?: string;
  subtitle?: string;
  // The right side of the title row.
  actions?: React.ReactNode;
  // A row under the title: a filter, a view toggle.
  toolbar?: React.ReactNode;
  measure?: keyof typeof MEASURE | "full";
  children?: React.ReactNode;
}): React.JSX.Element {
  const { isOverlay } = useSidebar();
  const bar = { back, crumbs, beside, controls };
  const showBar =
    Object.values(bar).some((part) => part !== undefined) || isOverlay;
  return (
    <div className="flex min-h-full w-full min-w-0 flex-col animate-in fade-in duration-(--duration-content-in)">
      {showBar && <PageBar {...bar} ruled={measure === "full"} />}
      {measure === "full" ? (
        children
      ) : (
        <div
          className={cn(
            "mx-auto flex w-full flex-1 flex-col gap-8 px-4 pb-12 sm:px-6",
            MEASURE[measure],
            title === undefined ? "pt-4" : showBar ? "pt-6" : "pt-16",
          )}
        >
          {title !== undefined && (
            <header className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="min-w-0 flex-1 truncate type-title">{title}</h1>
                {actions !== undefined && (
                  <div className="flex shrink-0 items-center gap-2">
                    {actions}
                  </div>
                )}
              </div>
              {subtitle !== undefined && (
                <p className="type-subtitle text-pretty">{subtitle}</p>
              )}
              {toolbar !== undefined && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {toolbar}
                </div>
              )}
            </header>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

/* A group of rows under its name. The name and its one-line lead sit on the
   stage and the rows in a card below, so a card only ever holds rows. */
export function Section({
  title,
  lead,
  action,
  className,
  children,
}: {
  title?: string;
  lead?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title !== undefined && <h2 className="type-heading">{title}</h2>}
            {lead !== undefined && (
              <p className="type-body text-pretty text-ink-muted">{lead}</p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
