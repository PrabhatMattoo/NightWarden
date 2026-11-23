import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ROLE_NAMES, type RoleName } from "@nightwarden/shared";

import { api, dataOrThrow } from "@/shared/api/client";
import { ROLE_LABEL } from "@/shared/lib/roles";
import { toast } from "@/shared/lib/toast";
import { Button, buttonVariants } from "@/shared/ui/button";
import { CheckboxOption } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Field, FieldError, FieldLabel, FieldTitle } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { invitationsQuery, mailQuery, teamsQuery } from "./queries";

export function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: teams } = useSuspenseQuery(teamsQuery());
  const { data: mail } = useSuspenseQuery(mailQuery());
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleName>("member");
  // The default team is ticked from the start; the admin decides by unticking it.
  const defaultTeamIds = teams.filter((t) => t.isDefault).map((t) => t.id);
  const [teamIds, setTeamIds] = useState<string[]>(defaultTeamIds);

  const invite = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/organization/invitations", {
          body: {
            email: email.trim(),
            role,
            ...(teamIds.length > 0 && { teamIds }),
          },
        }),
      ),
    onSuccess: async () => {
      toast.success(`Invitation sent to ${email.trim()}`);
      await queryClient.invalidateQueries({
        queryKey: invitationsQuery().queryKey,
      });
      close(false);
    },
  });

  function close(nextOpen: boolean): void {
    if (!nextOpen) {
      setEmail("");
      setRole("member");
      setTeamIds(defaultTeamIds);
      invite.reset();
    }
    onOpenChange(nextOpen);
  }

  const mailIsSet =
    mail.host !== null && mail.port !== null && mail.from !== null;

  // An invitation travels only by email, so without a mail server there is nothing to fill in.
  if (!mailIsSet) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set up email first</DialogTitle>
            <DialogDescription>
              Invitations go out by email, so NightWarden needs a mail server
              before it can invite anyone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Link
              to="/settings/$section"
              params={{ section: "email" }}
              className={buttonVariants()}
            >
              Set up email
            </Link>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite someone</DialogTitle>
            <DialogDescription>
              They get an email with a link that works for seven days.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-role">Role</FieldLabel>
              <Select
                items={ROLE_LABEL}
                value={role}
                onValueChange={(value) =>
                  setRole(ROLE_NAMES.find((name) => name === value) ?? role)
                }
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_NAMES.map((name) => (
                    <SelectItem key={name} value={name}>
                      {ROLE_LABEL[name]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {teams.length > 0 && (
              <Field>
                <FieldTitle id="invite-teams-label">Teams</FieldTitle>
                <div
                  role="group"
                  aria-labelledby="invite-teams-label"
                  className="flex flex-col gap-1"
                >
                  {teams.map((team) => (
                    <CheckboxOption
                      key={team.id}
                      checked={teamIds.includes(team.id)}
                      onCheckedChange={(checked) =>
                        setTeamIds((ids) =>
                          checked
                            ? [...ids, team.id]
                            : ids.filter((id) => id !== team.id),
                        )
                      }
                    >
                      <span className="type-body">{team.name}</span>
                    </CheckboxOption>
                  ))}
                </div>
              </Field>
            )}
            {invite.error !== null && (
              <FieldError>{invite.error.message}</FieldError>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={invite.isPending || email.trim() === ""}
            >
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
