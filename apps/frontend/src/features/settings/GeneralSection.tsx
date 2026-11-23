import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

import { api, dataOrThrow } from "@/shared/api/client";
import { Input } from "@/shared/ui/input";
import { toast } from "@/shared/lib/toast";
import { organizationQuery } from "./queries";
import { PictureRow } from "./PictureRow";
import { rowLabel, SettingsGroup, SettingsRow } from "./SettingsRow";

// One write for the name and the logo; every page reads both from the same query.
function useUpdateOrganization(failure: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: { name?: string; logo?: string | null }) =>
      dataOrThrow(api.PATCH("/api/organization", { body: patch })),
    onSuccess: (saved) =>
      queryClient.setQueryData(organizationQuery().queryKey, saved),
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

export function GeneralSection(): React.JSX.Element {
  const { data: organization } = useSuspenseQuery(organizationQuery());
  return (
    <SettingsGroup>
      <LogoRow name={organization.name} logo={organization.logo} />
      <NameRow name={organization.name} />
    </SettingsGroup>
  );
}
