import { useRef, useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

import { authCall, authClient } from "@/shared/api/authClient";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { avatarDataUrl } from "@/shared/lib/avatarImage";
import { toast } from "@/shared/lib/toast";
import { authSessionQuery } from "@/features/auth/queries";
import { UserAvatar } from "@/features/auth/UserAvatar";
import { AppearanceGroup } from "./AppearanceGroup";
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

function PictureRow({
  name,
  image,
}: {
  name: string;
  image: string | null;
}): React.JSX.Element {
  const picker = useRef<HTMLInputElement>(null);
  const update = useUpdateProfile("Picture not saved");
  return (
    <SettingsRow id="settings-picture" title="Profile picture">
      <div className="flex items-center gap-3">
        {image !== null && (
          <Button
            type="button"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate({ image: null })}
          >
            Remove
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={update.isPending}
          onClick={() => picker.current?.click()}
        >
          {image === null ? "Upload" : "Change"}
        </Button>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-labelledby={rowLabel("settings-picture")}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file === undefined) return;
            avatarDataUrl(file)
              .then((next) => update.mutate({ image: next }))
              .catch((err: unknown) =>
                toast.show({
                  title: "Picture not saved",
                  message:
                    err instanceof Error
                      ? err.message
                      : "It could not be read.",
                  variant: "error",
                }),
              );
          }}
        />
        <UserAvatar name={name} image={image} />
      </div>
    </SettingsRow>
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
        <PictureRow name={user.name} image={user.image ?? null} />
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
