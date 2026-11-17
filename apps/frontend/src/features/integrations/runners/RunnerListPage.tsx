import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import type { Platform, RunnerRecord } from "@nightwarden/shared";
import { Plus } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/shared/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { ServerCard } from "@/features/integrations/runners/ServerCard";
import { Button } from "@/shared/ui/button";
import { Section } from "@/shared/ui/Page";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { ICON_UI } from "@/shared/lib/iconProps";
import { api, dataOrThrow } from "@/shared/api/client";
import { INTEGRATION_CATALOG } from "../catalog";
import { runnersQuery } from "../queries";
import { connectedOn } from "./connectedOn";
import { IntegrationPage, metaFacts } from "../IntegrationPage";

// The two platforms are genuinely different things - a machine running
// containers, and a cluster - so each gets its own noun, page and install path.

export const PLATFORM_COPY: Record<
  Platform,
  { plural: string; singular: string; emptyHint: string }
> = {
  docker: {
    plural: "Docker hosts",
    singular: "Docker host",
    emptyHint:
      "The runner connected but sees no containers. That usually means the Docker socket is not mounted.",
  },
  kubernetes: {
    plural: "Kubernetes clusters",
    singular: "Kubernetes cluster",
    emptyHint:
      "The runner connected but sees no workloads. That usually means its service account cannot list them.",
  },
};

const SORT_FIELDS = ["name", "status", "lastSeen", "services"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SORT_LABEL: Record<SortField, string> = {
  name: "Name",
  status: "Status",
  services: "Services",
  lastSeen: "Last seen",
};
type SortDir = "asc" | "desc";

function compareRunners(
  a: RunnerRecord,
  b: RunnerRecord,
  field: SortField,
  dir: SortDir,
): number {
  let cmp = 0;
  switch (field) {
    case "name":
      cmp = a.serverName.localeCompare(b.serverName);
      break;
    case "status": {
      cmp = (a.online ? 1 : 0) - (b.online ? 1 : 0);
      break;
    }
    case "lastSeen": {
      const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
      const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
      cmp = aTime - bTime;
      break;
    }
    case "services": {
      const aCount = a.manifest?.services.length ?? 0;
      const bCount = b.manifest?.services.length ?? 0;
      cmp = aCount - bCount;
      break;
    }
  }
  return dir === "asc" ? cmp : -cmp;
}

export function RunnerListPage({
  platform,
}: {
  platform: Platform;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const copy = PLATFORM_COPY[platform];

  // A failed poll keeps the last list and says so, rather than emptying the page.
  const { data: runners, isError } = useSuspenseQuery({
    ...runnersQuery(),
    refetchInterval: 30_000,
  });

  const [removing, setRemoving] = useState<RunnerRecord | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) =>
      dataOrThrow(
        api.DELETE("/api/runners/{id}", { params: { path: { id } } }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: runnersQuery().queryKey }),
  });

  const connected = connectedOn(runners, platform);
  const sorted = [...connected].sort((a, b) =>
    compareRunners(a, b, sortField, sortDir),
  );

  function handleSort(field: SortField): void {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  // Nothing to list, so an empty fleet goes to the wizard, not an empty page.
  if (connected.length === 0) {
    return <Navigate to={`/integrations/${platform}/add`} replace />;
  }

  const identity = INTEGRATION_CATALOG[platform];
  const offline = connected.filter((r) => !r.online).length;
  return (
    <IntegrationPage
      identity={identity}
      facts={metaFacts(identity)}
      state={
        offline > 0
          ? { tone: "warn", label: `${offline} of ${connected.length} offline` }
          : { tone: "ok", label: `${connected.length} connected` }
      }
    >
      {remove.error !== null && (
        <Alert variant="destructive">
          <AlertTitle>Remove failed</AlertTitle>
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Failed to load {copy.plural.toLowerCase()}</AlertTitle>
          <AlertDescription>
            Something went wrong loading them. It will retry automatically.
          </AlertDescription>
        </Alert>
      )}

      <Section
        title={copy.plural}
        action={
          <div className="flex items-center gap-2">
            {connected.length > 1 && (
              <Select
                items={SORT_LABEL}
                value={sortField}
                onValueChange={(value) => {
                  const field = SORT_FIELDS.find((f) => f === value);
                  if (field !== undefined) handleSort(field);
                }}
              >
                <SelectTrigger aria-label="Sort by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SORT_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="secondary"
              onClick={() =>
                void navigate({ to: `/integrations/${platform}/add` })
              }
            >
              <Plus {...ICON_UI} />
              Add a {copy.singular.toLowerCase()}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {sorted.map((runner) => (
            <ServerCard
              key={runner.id}
              runner={runner}
              actions={
                <Button
                  variant="destructive-ghost"
                  size="sm"
                  disabled={remove.isPending && remove.variables === runner.id}
                  aria-label={`Remove ${runner.serverName}`}
                  onClick={() => setRemoving(runner)}
                >
                  Remove
                </Button>
              }
            />
          ))}
        </div>
      </Section>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.serverName ?? ""}?`}
        description="Its runner token is revoked, so the runner disconnects and cannot come back without a new install."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing.id);
        }}
      />
    </IntegrationPage>
  );
}
