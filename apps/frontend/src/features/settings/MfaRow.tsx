import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";

import { authCall, authClient } from "@/shared/api/authClient";
import { ICON_UI } from "@/shared/lib/iconProps";
import { toast } from "@/shared/lib/toast";
import { Badge } from "@/shared/ui/badge";
import { Button, buttonVariants } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { FieldError } from "@/shared/ui/field";
import { hasMfa } from "@/features/auth/mfa";
import { AuthField } from "@/features/auth/AuthForm";
import { authSessionQuery } from "@/features/auth/queries";
import { RecoveryCodes } from "@/features/auth/RecoveryCodes";
import { organizationQuery } from "./queries";
import { SettingsRow } from "./SettingsRow";

type Action = "regenerate" | "remove";

/* Both ask for the password again, since a session left open on a borrowed
   machine must not be enough to weaken the account. */
function MfaPasswordDialog({
  action,
  onClose,
}: {
  action: Action | null;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      if (action === "remove") {
        await authCall(authClient.twoFactor.disable({ password }));
        return null;
      }
      const fresh = await authCall(
        authClient.twoFactor.generateBackupCodes({ password }),
      );
      if (fresh === null) throw new Error("No recovery codes were issued.");
      return fresh.backupCodes;
    },
    onSuccess: async (fresh) => {
      setPassword("");
      await queryClient.query({ ...authSessionQuery(), staleTime: 0 });
      if (fresh === null) {
        toast.show({
          title: "MFA removed",
          message: "Sign-in asks for your password alone.",
          variant: "success",
        });
        close();
      } else {
        setCodes(fresh);
      }
    },
  });

  function close(): void {
    setPassword("");
    setCodes(null);
    run.reset();
    onClose();
  }

  const removing = action === "remove";
  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        {codes === null ? (
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {removing ? "Remove MFA" : "Regenerate recovery codes"}
              </DialogTitle>
              <DialogDescription>
                {removing
                  ? "Sign-in will ask for your password alone. Your recovery codes stop working."
                  : "The codes you have now stop working. The new ones are shown once."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <AuthField
                id="settings-mfa-password"
                type="password"
                label="Password"
                value={password}
                autoComplete="current-password"
                onChange={setPassword}
              />
              {run.error !== null && (
                <FieldError>{run.error.message}</FieldError>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={removing ? "destructive" : "default"}
                disabled={run.isPending || password === ""}
              >
                {removing ? "Remove MFA" : "Regenerate"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-6">
            <DialogHeader>
              <DialogTitle>Your new recovery codes</DialogTitle>
              <DialogDescription>
                Each signs you in once. They are not shown again.
              </DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={codes} />
            <DialogFooter>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MfaRow(): React.JSX.Element {
  const { data: session } = useSuspenseQuery(authSessionQuery());
  const { data: organization } = useSuspenseQuery(organizationQuery());
  const [action, setAction] = useState<Action | null>(null);
  const enabled = hasMfa(session);

  return (
    <SettingsRow
      id="settings-mfa"
      title="Multi-factor authentication"
      badge={<Badge variant="muted">{enabled ? "On" : "Off"}</Badge>}
      description="Asks for a code from an authenticator app when you sign in."
    >
      {enabled ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" variant="secondary" />}
            >
              Manage
              <ChevronDown {...ICON_UI} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setAction("regenerate")}>
                Regenerate recovery codes
              </DropdownMenuItem>
              {!organization.requireMfa && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setAction("remove")}
                >
                  Remove MFA
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <MfaPasswordDialog action={action} onClose={() => setAction(null)} />
        </>
      ) : (
        <Link
          to="/mfa/setup"
          className={buttonVariants({ variant: "secondary" })}
        >
          Set up
        </Link>
      )}
    </SettingsRow>
  );
}
