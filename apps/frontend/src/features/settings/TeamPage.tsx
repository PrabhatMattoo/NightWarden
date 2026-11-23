import { useState } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";

import { api, dataOrThrow } from "@/shared/api/client";
import { toast } from "@/shared/lib/toast";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { Input } from "@/shared/ui/input";
import { Page, Section } from "@/shared/ui/Page";
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
import { UserAvatar } from "@/features/auth/UserAvatar";
import { membersQuery, teamsQuery } from "./queries";
import { rowLabel, SettingsGroup, SettingsRow } from "./SettingsRow";
import { useRefreshTeams } from "./TeamsSection";

function reportFailure(title: string): (err: Error) => void {
  return (err) => toast.show({ title, message: err.message, variant: "error" });
}

const TEAMS_PAGE = {
  to: "/settings/$section",
  params: { section: "teams" },
} as const;

// One team: who is in it, its name, and its removal. The default team stays.
export function TeamPage(): React.JSX.Element {
  const { teamId } = useParams({ from: "/app/settings/teams/$teamId" });
  const navigate = useNavigate();
  const refresh = useRefreshTeams();
  const { data: teams } = useSuspenseQuery(teamsQuery());
  const { data: members } = useSuspenseQuery(membersQuery());
  const team = teams.find((candidate) => candidate.id === teamId);
  // Held only while typing; the saved name shows once the field is left.
  const [draft, setDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const rename = useMutation({
    mutationFn: (name: string) =>
      dataOrThrow(
        api.PATCH("/api/organization/teams/{id}", {
          params: { path: { id: teamId } },
          body: { name },
        }),
      ),
    onSuccess: refresh,
    onError: reportFailure("Name not saved"),
  });
  const add = useMutation({
    mutationFn: (userId: string) =>
      dataOrThrow(
        api.POST("/api/organization/teams/{id}/members", {
          params: { path: { id: teamId } },
          body: { userId },
        }),
      ),
    onSuccess: refresh,
    onError: reportFailure("Could not add the member"),
  });
  const take = useMutation({
    mutationFn: (userId: string) =>
      dataOrThrow(
        api.DELETE("/api/organization/teams/{id}/members/{userId}", {
          params: { path: { id: teamId, userId } },
        }),
      ),
    onSuccess: refresh,
    onError: reportFailure("Could not remove the member"),
  });
  const remove = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.DELETE("/api/organization/teams/{id}", {
          params: { path: { id: teamId } },
        }),
      ),
    onSuccess: async () => {
      await navigate(TEAMS_PAGE);
      await refresh();
    },
    onError: reportFailure("Could not delete the team"),
  });

  if (team === undefined) {
    return (
      <Page
        back={{ to: "/settings/teams", label: "Teams" }}
        title="No such team"
      >
        <p className="type-body text-ink-muted">
          It may have been deleted. Go back to Teams to see the ones there are.
        </p>
      </Page>
    );
  }

  const inTeam = members.filter((member) =>
    member.teams.some((t) => t.id === team.id),
  );
  const candidates = members.filter((member) => !inTeam.includes(member));

  function commitName(): void {
    if (draft === null || team === undefined) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== "" && next !== team.name) rename.mutate(next);
  }

  return (
    <Page back={{ to: "/settings/teams", label: "Teams" }} title={team.name}>
      <SettingsGroup>
        <SettingsRow id="settings-team-name" title="Name">
          <Input
            aria-labelledby={rowLabel("settings-team-name")}
            measure="text"
            autoComplete="off"
            value={draft ?? team.name}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <Section
        title="Members"
        action={
          candidates.length > 0 && (
            <Select
              items={Object.fromEntries(
                candidates.map((member) => [member.userId, member.name]),
              )}
              value={null}
              onValueChange={(userId) => {
                if (userId !== null) add.mutate(userId);
              }}
            >
              <SelectTrigger aria-label="Add a member">
                <SelectValue placeholder="Add a member" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        }
      >
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inTeam.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2}>
                    <span className="text-ink-muted">
                      No one is in this team yet.
                    </span>
                  </TableCell>
                </TableRow>
              ) : (
                inTeam.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>
                      <span className="flex items-center gap-3">
                        <UserAvatar
                          size="sm"
                          name={member.name}
                          image={member.image}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-ink-title">
                            {member.name}
                          </span>
                          <span className="truncate text-ink-muted">
                            {member.email}
                          </span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${member.name} from ${team.name}`}
                        disabled={
                          take.isPending && take.variables === member.userId
                        }
                        onClick={() => take.mutate(member.userId)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </Section>

      {!team.isDefault && (
        <>
          <div>
            <Button
              type="button"
              variant="destructive-ghost"
              onClick={() => setDeleting(true)}
            >
              Delete team
            </Button>
          </div>
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`Delete ${team.name}?`}
            description="The team is deleted. Its members stay in the organization."
            confirmLabel="Delete"
            destructive
            onConfirm={() => remove.mutate()}
          />
        </>
      )}
    </Page>
  );
}
