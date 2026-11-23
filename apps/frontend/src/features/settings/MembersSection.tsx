import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Ellipsis, Plus } from "lucide-react";
import { ADMIN_ROLE, ROLE_NAMES } from "@nightwarden/shared";
import type { OrganizationMember } from "@nightwarden/shared";

import { api, dataOrThrow } from "@/shared/api/client";
import { ICON_UI } from "@/shared/lib/iconProps";
import { ROLE_LABEL } from "@/shared/lib/roles";
import { dayClock } from "@/shared/lib/time";
import { toast } from "@/shared/lib/toast";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { FieldError } from "@/shared/ui/field";
import { Section } from "@/shared/ui/Page";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { authSessionQuery } from "@/features/auth/queries";
import { UserAvatar } from "@/features/auth/UserAvatar";
import { InviteDialog } from "./InviteDialog";
import { invitationsQuery, membersQuery, teamsQuery } from "./queries";

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function RoleSelect({
  member,
  soleAdmin,
  onChangeRole,
}: {
  member: OrganizationMember;
  soleAdmin: boolean;
  onChangeRole: (role: OrganizationMember["role"]) => void;
}): React.JSX.Element {
  const select = (
    <Select
      items={ROLE_LABEL}
      disabled={soleAdmin}
      value={member.role}
      onValueChange={(value) => {
        const role = ROLE_NAMES.find((name) => name === value);
        if (role !== undefined && role !== member.role) onChangeRole(role);
      }}
    >
      <SelectTrigger aria-label={`Role of ${member.name}`}>
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
  );
  if (!soleAdmin) return select;
  // A disabled control takes no pointer, so the reason hangs on what wraps it.
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {select}
      </TooltipTrigger>
      <TooltipContent>
        The organization needs at least one admin.
      </TooltipContent>
    </Tooltip>
  );
}

function MemberRow({
  member,
  soleAdmin,
  isSelf,
  error,
  onChangeRole,
  onRemove,
}: {
  member: OrganizationMember;
  // The organization needs an admin, so the last one can be neither demoted nor removed.
  soleAdmin: boolean;
  // Nobody resets their own MFA or removes themselves from here.
  isSelf: boolean;
  error: string | null;
  onChangeRole: (role: OrganizationMember["role"]) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const teams = member.teams.map((team) => team.name).join(", ");
  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-3">
          <UserAvatar size="sm" name={member.name} image={member.image} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-ink-title">{member.name}</span>
            <span className="truncate text-ink-muted">{member.email}</span>
            {error !== null && <FieldError>{error}</FieldError>}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className="text-ink-muted">{teams === "" ? "—" : teams}</span>
      </TableCell>
      <TableCell>
        <RoleSelect
          member={member}
          soleAdmin={soleAdmin}
          onChangeRole={onChangeRole}
        />
      </TableCell>
      <TableCell className="w-12 text-right">
        {!isSelf && !soleAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${member.name}`}
                />
              }
            >
              <Ellipsis {...ICON_UI} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

export function MembersSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: members } = useSuspenseQuery(membersQuery());
  const { data: invitations } = useSuspenseQuery(invitationsQuery());
  const { data: session } = useSuspenseQuery(authSessionQuery());
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<OrganizationMember | null>(null);
  const adminCount = members.filter((m) => m.role === ADMIN_ROLE).length;

  // Member counts on the teams page move with who is in the organization.
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: membersQuery().queryKey }),
      queryClient.invalidateQueries({ queryKey: teamsQuery().queryKey }),
    ]);
  };

  const changeRole = useMutation({
    mutationFn: (vars: { id: string; role: OrganizationMember["role"] }) =>
      dataOrThrow(
        api.PATCH("/api/organization/members/{id}", {
          params: { path: { id: vars.id } },
          body: { role: vars.role },
        }),
      ),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      dataOrThrow(
        api.DELETE("/api/organization/members/{id}", {
          params: { path: { id } },
        }),
      ),
    onSuccess: refresh,
    onError: (err) =>
      toast.show({
        title: "Could not remove the member",
        message: err.message,
        variant: "error",
      }),
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      dataOrThrow(
        api.DELETE("/api/organization/invitations/{id}", {
          params: { path: { id } },
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: invitationsQuery().queryKey }),
    onError: (err) =>
      toast.show({
        title: "Could not cancel the invitation",
        message: err.message,
        variant: "error",
      }),
  });

  return (
    <div className="flex flex-col gap-8">
      <Section
        title={count(members.length, "member")}
        action={
          <Button variant="secondary" onClick={() => setInviting(true)}>
            <Plus {...ICON_UI} />
            Invite
          </Button>
        }
      >
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Teams</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  soleAdmin={member.role === ADMIN_ROLE && adminCount === 1}
                  isSelf={member.userId === session?.user.id}
                  error={
                    changeRole.error !== null &&
                    changeRole.variables?.id === member.id
                      ? changeRole.error.message
                      : null
                  }
                  onChangeRole={(role) =>
                    changeRole.mutate({ id: member.id, role })
                  }
                  onRemove={() => setRemoving(member)}
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>

      {/* A section appears with its first row: an empty heading reads as unfinished. */}
      {invitations.length > 0 && (
        <Section title="Pending invitations">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-ink-title">
                          {invitation.email}
                        </span>
                        {invitation.inviterName !== null && (
                          <span className="truncate text-ink-muted">
                            Invited by {invitation.inviterName}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>{ROLE_LABEL[invitation.role]}</TableCell>
                    <TableCell>
                      <span className="text-ink-muted">
                        {dayClock(invitation.expiresAt)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Cancel the invitation for ${invitation.email}`}
                        disabled={
                          cancel.isPending && cancel.variables === invitation.id
                        }
                        onClick={() => cancel.mutate(invitation.id)}
                      >
                        Cancel
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>
      )}

      <InviteDialog open={inviting} onOpenChange={setInviting} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? ""}?`}
        description={`${removing?.name ?? ""} is signed out and loses access. Their chats are kept, and inviting ${removing?.email ?? ""} again restores them.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing.id);
        }}
      />
    </div>
  );
}
