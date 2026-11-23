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
import { FieldError } from "@/shared/ui/field";
import { toast } from "@/shared/lib/toast";
import { timeAgo } from "@/shared/lib/time";
import { AuthField } from "@/features/auth/AuthForm";
import { authSessionQuery, devicesQuery } from "@/features/auth/queries";
import { MfaRow } from "./MfaRow";
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
            <AuthField
              id="settings-current-password"
              type="password"
              label="Current password"
              value={current}
              autoComplete="current-password"
              onChange={setCurrent}
            />
            <AuthField
              id="settings-new-password"
              type="password"
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
  const { data: current } = useSuspenseQuery(authSessionQuery());
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: devicesQuery().queryKey });
  const revoke = useMutation({
    mutationFn: (token: string) =>
      authCall(authClient.revokeSession({ token })),
    onSuccess: refresh,
  });
  const revokeOthers = useMutation({
    mutationFn: () => authCall(authClient.revokeOtherSessions()),
    onSuccess: refresh,
  });
  const thisDevice = current?.session.id;

  return (
    <SettingsGroup
      title="Signed-in devices"
      action={
        sessions.length > 1 && (
          <Button
            type="button"
            variant="secondary"
            disabled={revokeOthers.isPending}
            onClick={() => revokeOthers.mutate()}
          >
            Sign out other devices
          </Button>
        )
      }
    >
      {sessions.map((session) => (
        <SettingsRow
          key={session.token}
          id={`settings-device-${session.id}`}
          title={describeDevice(session.userAgent)}
          description={
            session.id === thisDevice
              ? "This device"
              : `Active ${timeAgo(session.updatedAt)} ago`
          }
        >
          {session.id !== thisDevice && (
            <Button
              type="button"
              variant="destructive-ghost"
              disabled={revoke.isPending && revoke.variables === session.token}
              onClick={() => revoke.mutate(session.token)}
            >
              Revoke
            </Button>
          )}
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

export function SecuritySection(): React.JSX.Element {
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
        <MfaRow />
      </SettingsGroup>
      <Devices />
    </div>
  );
}
