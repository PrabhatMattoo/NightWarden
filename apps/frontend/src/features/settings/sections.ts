import {
  Box,
  Building2,
  CircleUser,
  Cpu,
  Gauge,
  Mail,
  Network,
  ScrollText,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@nightwarden/shared/permissions";

const ACCOUNT_SECTIONS = [
  { id: "profile", label: "Profile", icon: CircleUser },
  { id: "security", label: "Security", icon: Shield },
] as const;

const ORGANIZATION_SECTIONS = [
  { id: "general", label: "General", icon: Building2 },
  { id: "members", label: "Members", icon: Users },
  { id: "teams", label: "Teams", icon: Network },
  { id: "email", label: "Email", icon: Mail },
  { id: "audit", label: "Audit log", icon: ScrollText },
] as const;

const AGENT_SECTIONS = [
  { id: "model-provider", label: "Model provider", icon: Cpu },
  { id: "limits", label: "Limits", icon: Gauge },
  { id: "sandbox", label: "Sandbox", icon: Box },
] as const;

type SectionId =
  | (typeof ACCOUNT_SECTIONS)[number]["id"]
  | (typeof ORGANIZATION_SECTIONS)[number]["id"]
  | (typeof AGENT_SECTIONS)[number]["id"];

interface SettingsGroupDefinition {
  label: string;
  // What a person needs for the group to exist for them at all.
  permission: Permission;
  items: readonly { id: SectionId; label: string; icon: LucideIcon }[];
}

export const SETTINGS_GROUPS: readonly SettingsGroupDefinition[] = [
  {
    label: "Account",
    permission: { session: ["read"] },
    items: ACCOUNT_SECTIONS,
  },
  {
    label: "Organization",
    permission: { settings: ["manage"] },
    items: ORGANIZATION_SECTIONS,
  },
  {
    label: "Agent",
    permission: { settings: ["manage"] },
    items: AGENT_SECTIONS,
  },
];

export const SECTIONS = SETTINGS_GROUPS.flatMap((group) => group.items);

// The group a section sits in, for a section named by a URL that may name none.
export function groupOfSection(
  section: string,
): SettingsGroupDefinition | undefined {
  return SETTINGS_GROUPS.find((group) =>
    group.items.some((item) => item.id === section),
  );
}
