import { Suspense, useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  ChevronDown,
  Ellipsis,
  LogOut,
  Plug,
  Settings,
  Telescope,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@nightwarden/shared/permissions";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuLabel,
  SidebarMenuTrigger,
  SidebarMenuTriggerMark,
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
import { useCan } from "@/features/auth/useCan";
import { useSignOut } from "@/features/auth/useSignOut";
import { InviteDialog } from "@/features/settings/InviteDialog";
import { organizationQuery } from "@/features/settings/queries";
import { SETTINGS_GROUPS } from "@/features/settings/sections";
import { cssNumber } from "@/shared/lib/cssNumber";
import { ICON_NAV, ICON_UI } from "@/shared/lib/iconProps";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";

const DOCS_URL = "https://github.com/PrabhatMattoo/NightWarden#readme";

// The rail keeps its own column from lg; narrower, it opens over the stage.
const WIDE = `(width >= ${cssNumber("--breakpoint-lg", 1024)}px)`;

interface NavItem {
  to: "/agent" | "/investigations" | "/integrations";
  label: string;
  icon: LucideIcon;
  // An item the person can never use is left out of their rail.
  permission: Permission;
}

// The whole of the sidebar's navigation. Lists and actions belong to the pages.
const NAV_ITEMS: readonly NavItem[] = [
  { to: "/agent", label: "Agent", icon: Bot, permission: { session: ["run"] } },
  {
    to: "/investigations",
    label: "Investigations",
    icon: Telescope,
    permission: { session: ["read"] },
  },
  {
    to: "/integrations",
    label: "Integrations",
    icon: Plug,
    permission: { integration: ["read"] },
  },
];

function NavLink({
  item: { to, label, icon: Icon, permission },
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}): React.JSX.Element | null {
  if (!useCan(permission)) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-label={label}
        tooltip={label}
        isActive={active}
        onClick={onNavigate}
        render={<Link to={to} />}
      >
        <Icon {...ICON_NAV} />
        <SidebarMenuLabel>{label}</SidebarMenuLabel>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// Settings is a level below the app: the rail drills into these groups and back out.
function SettingsNavGroup({
  group,
  isActive,
  onNavigate,
}: {
  group: (typeof SETTINGS_GROUPS)[number];
  isActive: (to: string) => boolean;
  onNavigate: () => void;
}): React.JSX.Element | null {
  if (!useCan(group.permission)) return null;
  return (
    <section aria-label={group.label}>
      <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
      <SidebarMenu>
        {group.items.map(({ id, label, icon: Icon }) => (
          <SidebarMenuItem key={id}>
            <SidebarMenuButton
              aria-label={label}
              tooltip={label}
              isActive={isActive(`/settings/${id}`)}
              onClick={onNavigate}
              render={<Link to="/settings/$section" params={{ section: id }} />}
            >
              <Icon {...ICON_NAV} />
              <SidebarMenuLabel>{label}</SidebarMenuLabel>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </section>
  );
}

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
  const { data: organization } = useSuspenseQuery(organizationQuery());
  const canInvite = useCan({ invitation: ["manage"] });
  const [inviting, setInviting] = useState(false);
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
        {/* The organization everything here belongs to; collapsed, its logo alone stays. */}
        <SidebarHeader className="h-12 flex-row items-center justify-between gap-2 overflow-hidden px-2 group-data-[collapsible=icon]:gap-0">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuTrigger
                  aria-label={`${organization.name} menu`}
                  className="min-w-0 flex-1"
                />
              }
            >
              <UserAvatar
                size="sm"
                name={organization.name}
                image={organization.logo}
              />
              <SidebarMenuLabel className="ms-1.5 flex-none">
                {organization.name}
              </SidebarMenuLabel>
              <ChevronDown
                aria-hidden
                className="ms-1 size-4 shrink-0 text-ink-faint group-data-[collapsible=icon]:hidden"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuItem
                render={<Link to="/settings" />}
                onClick={dismissOverlay}
              >
                <Settings {...ICON_UI} />
                Settings
              </DropdownMenuItem>
              {canInvite && (
                <DropdownMenuItem onClick={() => setInviting(true)}>
                  <UserPlus {...ICON_UI} />
                  Invite members
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {!isOverlay && <SidebarTrigger className="shrink-0" />}
        </SidebarHeader>

        <SidebarContent>
          {/* Both levels stay mounted in one cell, so leaving slides one out as the other slides in. */}
          <div className="grid grid-cols-1 overflow-x-hidden">
            <div inert={inSettings} data-side="start" className="drill-level">
              <SidebarGroup>
                <SidebarMenu>
                  {NAV_ITEMS.map((item) => (
                    <NavLink
                      key={item.to}
                      item={item}
                      active={isActive(item.to)}
                      onNavigate={dismissOverlay}
                    />
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
                    <SettingsNavGroup
                      key={group.label}
                      group={group}
                      isActive={isActive}
                      onNavigate={dismissOverlay}
                    />
                  ))}
                </div>
              </SidebarGroup>
            </div>
          </div>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem ref={accountRow}>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SidebarMenuTrigger aria-label="Account menu" />}
                >
                  <UserAvatar size="sm" name={name} image={image} />
                  <SidebarMenuLabel className="ms-1.5">{name}</SidebarMenuLabel>
                  <SidebarMenuTriggerMark>
                    <Ellipsis />
                  </SidebarMenuTriggerMark>
                </DropdownMenuTrigger>
                {/* Opens over the whole row, as wide as it. */}
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

      {/* Mounted only while open: it reads the teams and the mail server, which no other page here needs. */}
      {inviting && (
        <Suspense fallback={null}>
          <InviteDialog open onOpenChange={setInviting} />
        </Suspense>
      )}

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
