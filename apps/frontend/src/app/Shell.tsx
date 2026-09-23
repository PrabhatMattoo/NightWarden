import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  Box,
  ChevronRight,
  CircleUser,
  Cpu,
  LogOut,
  Plug,
  Settings,
  Telescope,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuLabel,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/shared/ui/sidebar";
import { useAuth } from "@/features/auth/AuthContext";
import { cn } from "@/shared/lib/utils";
import { cssNumber } from "@/shared/lib/cssNumber";
import { ICON_NAV } from "@/shared/lib/iconProps";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";

// The rail keeps its own column from lg; narrower, it opens over the stage.
const WIDE = `(width >= ${cssNumber("--breakpoint-lg", 1024)}px)`;

// The whole of the sidebar's navigation. Lists and actions belong to the pages.
const NAV_ITEMS = [
  { to: "/agent", label: "Agent", icon: Bot },
  { to: "/investigations", label: "Investigations", icon: Telescope },
  { to: "/integrations", label: "Integrations", icon: Plug },
] as const;

// Settings is its own panel: the rail swaps to these sections and offers a way
// back to the app rather than sharing the app's own shell.
const SETTINGS_NAV = [
  { section: "provider", label: "Provider", icon: Cpu },
  { section: "agent", label: "Agent", icon: Bot },
  { section: "sandbox", label: "Sandbox", icon: Box },
  { section: "account", label: "Account", icon: CircleUser },
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
  const { logout } = useAuth();
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
        <SidebarHeader className="h-12 flex-row items-center justify-between gap-2 overflow-hidden px-3 group-data-[collapsible=icon]:gap-0">
          <span
            className={cn(
              "nav-label-motion min-w-0 flex-1 truncate ps-2 whitespace-nowrap type-heading",
              "group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0",
            )}
          >
            NightWarden
          </span>
          {!isOverlay && <SidebarTrigger className="shrink-0" />}
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {inSettings ? (
                <>
                  {/* The panel's header and its way out, in one row. */}
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
                  {SETTINGS_NAV.map(({ section, label, icon: Icon }) => (
                    <SidebarMenuItem key={section}>
                      <SidebarMenuButton
                        aria-label={label}
                        tooltip={label}
                        isActive={isActive(`/settings/${section}`)}
                        onClick={dismissOverlay}
                        render={
                          <Link to="/settings/$section" params={{ section }} />
                        }
                      >
                        <Icon {...ICON_NAV} />
                        <SidebarMenuLabel>{label}</SidebarMenuLabel>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </>
              ) : (
                NAV_ITEMS.map(({ to, label, icon: Icon }) => (
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
                ))
              )}
            </SidebarMenu>
          </SidebarGroup>
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
                    className="ml-auto size-4 text-ink-faint group-data-[collapsible=icon]:hidden"
                  />
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-label="Log out"
                tooltip="Log out"
                onClick={() => {
                  dismissOverlay();
                  void logout();
                }}
              >
                <LogOut {...ICON_NAV} />
                <SidebarMenuLabel>Log out</SidebarMenuLabel>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

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
