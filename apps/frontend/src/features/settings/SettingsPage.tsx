import { useParams } from "@tanstack/react-router";

import { Page } from "@/shared/ui/Page";
import { AuditSection } from "@/features/settings/AuditSection";
import {
  ConfigSections,
  isConfigSection,
} from "@/features/settings/ConfigSections";
import { GeneralSection } from "@/features/settings/GeneralSection";
import { MailSection } from "@/features/settings/MailSection";
import { MembersSection } from "@/features/settings/MembersSection";
import { ProfileSection } from "@/features/settings/ProfileSection";
import { SecuritySection } from "@/features/settings/SecuritySection";
import { SECTIONS } from "@/features/settings/sections";
import { TeamsSection } from "@/features/settings/TeamsSection";

/* The route has already sent anyone without the right to an Organization
   section to Profile, so a section here is one the person may open. */
export function SettingsPage(): React.JSX.Element {
  const { section } = useParams({ strict: false });
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <Page title={active.label}>
      {isConfigSection(active.id) && <ConfigSections active={active.id} />}
      {active.id === "profile" && <ProfileSection />}
      {active.id === "security" && <SecuritySection />}
      {active.id === "general" && <GeneralSection />}
      {active.id === "members" && <MembersSection />}
      {active.id === "teams" && <TeamsSection />}
      {active.id === "email" && <MailSection />}
      {active.id === "audit" && <AuditSection />}
    </Page>
  );
}
