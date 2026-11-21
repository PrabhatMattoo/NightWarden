import { useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  Box,
  ChevronRight,
  CircleUser,
  Cpu,
  Ellipsis,
  Gauge,
  LogOut,
  Plug,
  Settings,
  Shield,
  Telescope,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuLabel,
  SidebarMenuStatic,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/shared/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { authSessionQuery } from "@/features/auth/queries";
import { UserAvatar } from "@/features/auth/UserAvatar";
import { useSignOut } from "@/features/auth/useSignOut";
import { cn } from "@/shared/lib/utils";
import { cssNumber } from "@/shared/lib/cssNumber";
import { ICON_NAV, ICON_UI } from "@/shared/lib/iconProps";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";

const DOCS_URL = "https://github.com/PrabhatMattoo/NightWarden#readme";

// The rail keeps its own column from lg; narrower, it opens over the stage.
const WIDE = `(width >= ${cssNumber("--breakpoint-lg", 1024)}px)`;

// The whole of the sidebar's navigation. Lists and actions belong to the pages.
const NAV_ITEMS = [
  { to: "/agent", label: "Agent", icon: Bot },
  { to: "/investigations", label: "Investigations", icon: Telescope },
  { to: "/integrations", label: "Integrations", icon: Plug },
] as const;

// Settings is a level below the app: the rail drills into these groups and back out.
const SETTINGS_GROUPS = [
  {
    label: "Account",
    items: [
      { section: "profile", label: "Profile", icon: CircleUser },
      { section: "security", label: "Security", icon: Shield },
    ],
  },
  {
    label: "Agent",
    items: [
      { section: "provider", label: "Provider", icon: Cpu },
      { section: "limits", label: "Limits", icon: Gauge },
      { section: "sandbox", label: "Sandbox", icon: Box },
    ],
  },
] as const;

export function Shell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SidebarProvider overlay={!useMediaQuery(WIDE)}>
      <ShellContent>{children}</ShellContent>
    </SidebarProvider>
  );
}

/* The pathname decides only which nav item is lit and whether Settings owns
   the rail; everything else is the route's own business. */
function ShellContent({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { isOverlay, setOpenOverlay } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const signOut = useSignOut();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const accountRow = useRef<HTMLLIElement>(null);
  const { data: session } = useSuspenseQuery(authSessionQuery());
  const name = session?.user.name ?? "";
  const image = session?.user.image ?? null;
  const inSettings = pathname.startsWith("/settings");

  function isActive(to: string): boolean {
    return pathname === to || pathname.startsWith(`${to}/`);
  }

  // In the overlay any navigation or action should also dismiss it.
  function dismissOverlay(): void {
    if (isOverlay) setOpenOverlay(false);
  }

  return (
    <>
      <a
        href="#main-content"
        className="absolute -top-10 left-2 z-(--z-skip-link) rounded-control bg-accent px-3 py-2 type-item text-on-accent no-underline focus:top-2"
      >
        Skip to content
      </a>

      <Sidebar>
        {/* The same 10px inset open and closed; the wordmark gives up its own 4px so the toggle ends on the rail's centre. */}
        <SidebarHeader className="h-12 flex-row items-center justify-between gap-2 overflow-hidden px-2.5 group-data-[collapsible=icon]:gap-0">
          <span
            className={cn(
              "nav-label-motion min-w-0 flex-1 truncate ps-1 whitespace-nowrap type-heading",
              "group-data-[collapsible=icon]:ps-0 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0",
            )}
          >
            NightWarden
          </span>
          {!isOverlay && <SidebarTrigger className="shrink-0" />}
        </SidebarHeader>

        <SidebarContent>
          {/* Both levels stay mounted in one cell, so leaving slides one out as the other slides in. */}
          <div className="grid grid-cols-1 overflow-x-hidden">
            <div inert={inSettings} data-side="start" className="drill-level">
              <SidebarGroup>
                <SidebarMenu>
                  {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
                    <SidebarMenuItem key={to}>
                      <SidebarMenuButton
                        aria-label={label}
                        tooltip={label}
                        isActive={isActive(to)}
                        onClick={dismissOverlay}
                        render={<Link to={to} />}
                      >
                        <Icon {...ICON_NAV} />
                        <SidebarMenuLabel>{label}</SidebarMenuLabel>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </div>
            <div inert={!inSettings} data-side="end" className="drill-level">
              <SidebarGroup>
                <div className="flex flex-col gap-4">
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-label="Back to the app"
                        tooltip="Back to the app"
                        onClick={dismissOverlay}
                        render={<Link to="/investigations" />}
                      >
                        <ArrowLeft {...ICON_NAV} />
                        <SidebarMenuLabel>Settings</SidebarMenuLabel>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                  {SETTINGS_GROUPS.map((group) => (
                    <section key={group.label} aria-label={group.label}>
                      <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                      <SidebarMenu>
                        {group.items.map(({ section, label, icon: Icon }) => (
                          <SidebarMenuItem key={section}>
                            <SidebarMenuButton
                              aria-label={label}
                              tooltip={label}
                              isActive={isActive(`/settings/${section}`)}
                              onClick={dismissOverlay}
                              render={
                                <Link
                                  to="/settings/$section"
                                  params={{ section }}
                                />
                              }
                            >
                              <Icon {...ICON_NAV} />
                              <SidebarMenuLabel>{label}</SidebarMenuLabel>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </section>
                  ))}
                </div>
              </SidebarGroup>
            </div>
          </div>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            {!inSettings && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  aria-label="Settings"
                  tooltip="Settings"
                  onClick={dismissOverlay}
                  render={<Link to="/settings" />}
                >
                  <Settings {...ICON_NAV} />
                  <SidebarMenuLabel>Settings</SidebarMenuLabel>
                  {/* A hint that this opens a panel rather than a page. */}
                  <ChevronRight
                    aria-hidden
                    strokeWidth={1.5}
                    className="ml-auto size-4 text-ink-faint highlight-motion group-hover/menu-button:text-ink-title group-data-[collapsible=icon]:hidden"
                  />
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem ref={accountRow}>
              <SidebarMenuStatic>
                <UserAvatar size="sm" name={name} image={image} />
                <SidebarMenuLabel className="ms-1.5">{name}</SidebarMenuLabel>
              </SidebarMenuStatic>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SidebarMenuAction aria-label="Account menu" />}
                >
                  <Ellipsis />
                </DropdownMenuTrigger>
                {/* Opens over the whole row, as wide as it, rather than off the small trigger. */}
                <DropdownMenuContent
                  side="top"
                  anchor={accountRow}
                  className="w-(--anchor-width)"
                >
                  <DropdownMenuItem
                    render={
                      <a
                        href={DOCS_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="external"
                      />
                    }
                  >
                    <BookOpen {...ICON_UI} />
                    Docs
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setConfirmingSignOut(true)}>
                    <LogOut {...ICON_UI} />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <ConfirmDialog
        open={confirmingSignOut}
        onOpenChange={setConfirmingSignOut}
        title="Sign out?"
        description="You will need your password to sign back in on this device."
        confirmLabel="Sign out"
        onConfirm={() => {
          dismissOverlay();
          signOut.mutate();
        }}
      />

      <SidebarInset
        id="main-content"
        tabIndex={-1}
        className="h-svh min-h-0 overflow-hidden"
      >
        {/* Scrolling is the page's to decide: a column of content scrolls here,
            and a report beside a rail scrolls inside its own column. */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
          {children}
        </div>
      </SidebarInset>
    </>
  );
}
