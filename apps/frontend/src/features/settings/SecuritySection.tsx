import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

import { PASSWORD_MIN_LENGTH } from "@nightwarden/shared";

import { authCall, authClient } from "@/shared/api/authClient";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field";
import { toast } from "@/shared/lib/toast";
import { timeAgo } from "@/shared/lib/time";
import { devicesQuery } from "@/features/auth/queries";
import { useSignOut } from "@/features/auth/useSignOut";
import { SettingsGroup, SettingsRow } from "./SettingsRow";

/* A user agent is a long string nobody reads, so it is reduced to the two facts
   that identify a device: which browser, on which system. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const system = /Mac OS X/.test(userAgent)
    ? "macOS"
    : /Windows/.test(userAgent)
      ? "Windows"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "an unknown system";
  return `${browser} on ${system}`;
}

function PasswordField({
  id,
  label,
  value,
  autoComplete,
  description,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  autoComplete: "current-password" | "new-password";
  description?: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        required
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      {description !== undefined && (
        <FieldDescription>{description}</FieldDescription>
      )}
    </Field>
  );
}

// Other devices sign out, since a password changes when one is no longer trusted.
function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: () =>
      authCall(
        authClient.changePassword({
          currentPassword: current,
          newPassword: next,
          revokeOtherSessions: true,
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: devicesQuery().queryKey,
      });
      toast.show({
        title: "Password changed",
        message: "Every other device has been signed out.",
        variant: "success",
      });
      close(false);
    },
  });

  function close(nextOpen: boolean): void {
    if (!nextOpen) {
      setCurrent("");
      setNext("");
      change.reset();
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Every other device is signed out once it changes.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <PasswordField
              id="settings-current-password"
              label="Current password"
              value={current}
              autoComplete="current-password"
              onChange={setCurrent}
            />
            <PasswordField
              id="settings-new-password"
              label="New password"
              value={next}
              autoComplete="new-password"
              description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
              onChange={setNext}
            />
            {change.error !== null && (
              <FieldError>{change.error.message}</FieldError>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                change.isPending ||
                current === "" ||
                next.length < PASSWORD_MIN_LENGTH
              }
            >
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Devices(): React.JSX.Element {
  const { data: sessions } = useSuspenseQuery(devicesQuery());
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (token: string) =>
      authCall(authClient.revokeSession({ token })),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: devicesQuery().queryKey }),
  });

  return (
    <SettingsGroup title="Signed-in devices">
      {sessions.map((session) => (
        <SettingsRow
          key={session.token}
          id={`settings-device-${session.token}`}
          title={describeDevice(session.userAgent)}
          description={`Signed in ${timeAgo(session.createdAt)} ago`}
        >
          <Button
            type="button"
            variant="destructive-ghost"
            disabled={revoke.isPending && revoke.variables === session.token}
            onClick={() => revoke.mutate(session.token)}
          >
            Revoke
          </Button>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

export function SecuritySection(): React.JSX.Element {
  const signOut = useSignOut();
  const signOutEverywhere = useSignOut({ everywhere: true });
  const [changing, setChanging] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup>
        <SettingsRow
          id="settings-password"
          title="Password"
          description="Changing it signs out every other device."
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => setChanging(true)}
          >
            Change password
          </Button>
          <ChangePasswordDialog open={changing} onOpenChange={setChanging} />
        </SettingsRow>
        <SettingsRow
          id="settings-sign-out"
          title="Sign out"
          description="Ends the session on this device."
        >
          <Button
            type="button"
            variant="secondary"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            Sign out
          </Button>
        </SettingsRow>
        <SettingsRow
          id="settings-sign-out-everywhere"
          title="Sign out everywhere"
          description="Ends every signed-in session, including this one."
        >
          <Button
            type="button"
            variant="destructive-ghost"
            disabled={signOutEverywhere.isPending}
            onClick={() => signOutEverywhere.mutate()}
          >
            Sign out everywhere
          </Button>
        </SettingsRow>
      </SettingsGroup>
      <Devices />
    </div>
  );
}
