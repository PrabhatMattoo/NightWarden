import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Organization } from "@nightwarden/shared";

import { api, dataOrThrow } from "@/shared/api/client";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { toast } from "@/shared/lib/toast";
import { hasMfa } from "@/features/auth/mfa";
import { authSessionQuery } from "@/features/auth/queries";
import { organizationQuery } from "./queries";
import { PictureRow } from "./PictureRow";
import { rowLabel, SettingsGroup, SettingsRow } from "./SettingsRow";

// One write for the name and the logo; every page reads both from the same query.
function useUpdateOrganization(failure: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: {
      name?: string;
      logo?: string | null;
      requireMfa?: boolean;
    }) => dataOrThrow(api.PATCH("/api/organization", { body: patch })),
    onSuccess: async (saved, patch) => {
      queryClient.setQueryData(organizationQuery().queryKey, saved);
      // Whoever has no MFA now reads as asked to set it up, or no longer does.
      if (patch.requireMfa !== undefined) {
        await queryClient.query({ ...authSessionQuery(), staleTime: 0 });
      }
    },
    onError: (err) =>
      toast.show({ title: failure, message: err.message, variant: "error" }),
  });
}

function NameRow({ name }: { name: string }): React.JSX.Element {
  // Held only while typing; the saved name shows once the field is left.
  const [draft, setDraft] = useState<string | null>(null);
  const update = useUpdateOrganization("Name not saved");

  function commit(): void {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== "" && next !== name) update.mutate({ name: next });
  }

  return (
    <SettingsRow
      id="settings-organization-name"
      title="Name"
      description="Shown to everyone you invite."
    >
      <Input
        aria-labelledby={rowLabel("settings-organization-name")}
        measure="text"
        autoComplete="organization"
        value={draft ?? name}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </SettingsRow>
  );
}

const LOGO_FAILURE = "Logo not saved";

function LogoRow({
  name,
  logo,
}: {
  name: string;
  logo: string | null;
}): React.JSX.Element {
  const update = useUpdateOrganization(LOGO_FAILURE);
  return (
    <PictureRow
      id="settings-organization-logo"
      title="Logo"
      name={name}
      image={logo}
      pending={update.isPending}
      failure={LOGO_FAILURE}
      onChange={(next) => update.mutate({ logo: next })}
    />
  );
}

/* Requiring MFA of everyone starts with the admin's own: without it the switch leads
   to setup, which turns the requirement on as it finishes. */
function RequireMfaRow({
  organization,
}: {
  organization: Organization;
}): React.JSX.Element {
  const { data: session } = useSuspenseQuery(authSessionQuery());
  const navigate = useNavigate();
  const update = useUpdateOrganization("Requirement not saved");
  const [asking, setAsking] = useState<"confirm" | "own-first" | null>(null);
  const lockedBy = organization.locked.requireMfa;

  return (
    <SettingsRow
      id="settings-require-mfa"
      title="Require MFA"
      description="Everyone must set up MFA before using NightWarden."
      lockedBy={lockedBy}
    >
      <Switch
        aria-labelledby={rowLabel("settings-require-mfa")}
        checked={organization.requireMfa}
        disabled={lockedBy !== undefined || update.isPending}
        onCheckedChange={(on) => {
          if (!on) update.mutate({ requireMfa: false });
          else setAsking(hasMfa(session) ? "confirm" : "own-first");
        }}
      />
      <ConfirmDialog
        open={asking === "confirm"}
        onOpenChange={(open) => !open && setAsking(null)}
        title="Require MFA?"
        description="Everyone without MFA is asked to set it up before they can do anything else."
        confirmLabel="Require MFA"
        onConfirm={() => update.mutate({ requireMfa: true })}
      />
      <ConfirmDialog
        open={asking === "own-first"}
        onOpenChange={(open) => !open && setAsking(null)}
        title="Set up your own MFA first"
        description="The requirement applies to you too. Set up MFA for your account, and it turns on for everyone when you finish."
        confirmLabel="Set up MFA"
        onConfirm={() =>
          void navigate({ to: "/mfa/setup", search: { after: "require-mfa" } })
        }
      />
    </SettingsRow>
  );
}

export function GeneralSection(): React.JSX.Element {
  const { data: organization } = useSuspenseQuery(organizationQuery());
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup>
        <LogoRow name={organization.name} logo={organization.logo} />
        <NameRow name={organization.name} />
      </SettingsGroup>
      <SettingsGroup title="Security">
        <RequireMfaRow organization={organization} />
      </SettingsGroup>
    </div>
  );
}
