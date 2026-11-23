import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

import { authCall, authClient } from "@/shared/api/authClient";
import { Input } from "@/shared/ui/input";
import { toast } from "@/shared/lib/toast";
import { authSessionQuery } from "@/features/auth/queries";
import { AppearanceGroup } from "./AppearanceGroup";
import { PictureRow } from "./PictureRow";
import { rowLabel, SettingsGroup, SettingsRow } from "./SettingsRow";

// One write for the name and the picture; every page reads both from the session.
function useUpdateProfile(failure: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: { name?: string; image?: string | null }) =>
      authCall(authClient.updateUser(patch)),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: authSessionQuery().queryKey }),
    onError: (err) =>
      toast.show({ title: failure, message: err.message, variant: "error" }),
  });
}

const PICTURE_FAILURE = "Picture not saved";

function ProfilePictureRow({
  name,
  image,
}: {
  name: string;
  image: string | null;
}): React.JSX.Element {
  const update = useUpdateProfile(PICTURE_FAILURE);
  return (
    <PictureRow
      id="settings-picture"
      title="Profile picture"
      name={name}
      image={image}
      pending={update.isPending}
      failure={PICTURE_FAILURE}
      onChange={(next) => update.mutate({ image: next })}
    />
  );
}

function NameRow({ name }: { name: string }): React.JSX.Element {
  // Held only while typing; the saved name shows once the field is left.
  const [draft, setDraft] = useState<string | null>(null);
  const update = useUpdateProfile("Name not saved");

  function commit(): void {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== "" && next !== name) update.mutate({ name: next });
  }

  return (
    <SettingsRow id="settings-name" title="Name">
      <Input
        aria-labelledby={rowLabel("settings-name")}
        measure="text"
        autoComplete="name"
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

// The layout has already sent a signed-out visitor to the login page.
export function ProfileSection(): React.JSX.Element | null {
  const { data: session } = useSuspenseQuery(authSessionQuery());
  if (session === null) return null;
  const { user } = session;
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup>
        <ProfilePictureRow name={user.name} image={user.image ?? null} />
        <SettingsRow id="settings-email" title="Email">
          <span
            aria-labelledby={rowLabel("settings-email")}
            className="type-body"
          >
            {user.email}
          </span>
        </SettingsRow>
        <NameRow name={user.name} />
      </SettingsGroup>
      <AppearanceGroup theme={user.theme} />
    </div>
  );
}
