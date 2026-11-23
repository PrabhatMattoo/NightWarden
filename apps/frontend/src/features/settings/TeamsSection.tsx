import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { api, dataOrThrow } from "@/shared/api/client";
import { ICON_UI } from "@/shared/lib/iconProps";
import { day } from "@/shared/lib/time";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Section } from "@/shared/ui/Page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { membersQuery, teamsQuery } from "./queries";

export function useRefreshTeams(): () => Promise<void> {
  const queryClient = useQueryClient();
  // Each member's team names and each team's count come from these two.
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: teamsQuery().queryKey }),
      queryClient.invalidateQueries({ queryKey: membersQuery().queryKey }),
    ]);
  };
}

function CreateTeamDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const refresh = useRefreshTeams();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/organization/teams", { body: { name: name.trim() } }),
      ),
    onSuccess: async () => {
      await refresh();
      close(false);
    },
  });

  function close(nextOpen: boolean): void {
    if (!nextOpen) {
      setName("");
      create.reset();
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
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New team</DialogTitle>
            <DialogDescription>
              Teams group people. Add them once the team exists.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="team-name">Name</FieldLabel>
            <Input
              id="team-name"
              required
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            {create.error !== null && (
              <FieldError>{create.error.message}</FieldError>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={create.isPending || name.trim() === ""}
            >
              Create team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TeamsSection(): React.JSX.Element {
  const { data: teams } = useSuspenseQuery(teamsQuery());
  const [creating, setCreating] = useState(false);

  return (
    <>
      <Section
        title={`${teams.length} ${teams.length === 1 ? "team" : "teams"}`}
        action={
          <Button variant="secondary" onClick={() => setCreating(true)}>
            <Plus {...ICON_UI} />
            New team
          </Button>
        }
      >
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((team) => (
                <TableRow key={team.id}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Link
                        to="/settings/teams/$teamId"
                        params={{ teamId: team.id }}
                        className="type-item text-ink-title after:absolute after:inset-0"
                      >
                        {team.name}
                      </Link>
                      {team.isDefault && <Badge variant="muted">Default</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>{team.memberCount}</TableCell>
                  <TableCell>
                    <span className="text-ink-muted">
                      {day(team.createdAt)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>

      <CreateTeamDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
