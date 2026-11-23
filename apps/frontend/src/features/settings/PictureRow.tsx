import { useRef } from "react";

import { Button } from "@/shared/ui/button";
import { avatarDataUrl } from "@/shared/lib/avatarImage";
import { toast } from "@/shared/lib/toast";
import { UserAvatar } from "@/features/auth/UserAvatar";
import { rowLabel, SettingsRow } from "./SettingsRow";

// A person's picture and the organization's logo are picked, cropped and stored the same way.
export function PictureRow({
  id,
  title,
  name,
  image,
  pending,
  failure,
  onChange,
}: {
  id: string;
  title: string;
  // What the initials are drawn from until a picture is set.
  name: string;
  image: string | null;
  pending: boolean;
  failure: string;
  onChange: (image: string | null) => void;
}): React.JSX.Element {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <SettingsRow id={id} title={title}>
      <div className="flex items-center gap-3">
        {image !== null && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => onChange(null)}
          >
            Remove
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => picker.current?.click()}
        >
          {image === null ? "Upload" : "Change"}
        </Button>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-labelledby={rowLabel(id)}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file === undefined) return;
            avatarDataUrl(file)
              .then(onChange)
              .catch((err: unknown) =>
                toast.show({
                  title: failure,
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
