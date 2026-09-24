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
import { Field, FieldLabel } from "@/shared/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { ServerCard } from "@/features/integrations/runners/ServerCard";
import { Button } from "@/shared/ui/button";
import { Page } from "@/shared/ui/Page";
import { ICON_UI } from "@/shared/lib/iconProps";
import { apiFetch } from "@/shared/api/client";
import { INTEGRATION_CATALOG } from "../catalog";
import { runnersQuery } from "../queries";
import { connectedOn } from "./connectedOn";
import { IntegrationHeader } from "@/features/integrations/IntegrationHeader";

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

type SortField = "name" | "status" | "lastSeen" | "services";

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

  const remove = useMutation({
    mutationFn: (token: string) =>
      apiFetch<void>(`/api/tokens/${token}`, { method: "DELETE" }),
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

  return (
    <Page
      measure="wide"
      back={{ to: "/integrations", label: "Integrations" }}
      controls={
        <Button
          size="sm"
          onClick={() => void navigate({ to: `/integrations/${platform}/add` })}
        >
          <Plus {...ICON_UI} />
          Add a {copy.singular.toLowerCase()}
        </Button>
      }
    >
      <div className="-mt-2 mb-4">
        <IntegrationHeader identity={INTEGRATION_CATALOG[platform]} />
      </div>

      {remove.error !== null && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Remove failed</AlertTitle>
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}

      {isError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Failed to load {copy.plural.toLowerCase()}</AlertTitle>
          <AlertDescription>
            Something went wrong loading them. It will retry automatically.
          </AlertDescription>
        </Alert>
      )}

      {connected.length > 1 && (
        <Field className="mb-3">
          <FieldLabel htmlFor="runner-sort">Sort by</FieldLabel>
          <Select
            items={SORT_LABEL}
            value={sortField}
            onValueChange={(value) => handleSort(value as SortField)}
          >
            <SelectTrigger id="runner-sort">
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
        </Field>
      )}

      <div className="flex flex-col gap-3">
        {sorted.map((runner) => (
          <ServerCard
            key={runner.id}
            runner={runner}
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={remove.isPending && remove.variables === runner.id}
                aria-label={`Remove ${runner.serverName}`}
                onClick={() => remove.mutate(runner.id)}
              >
                Remove
              </Button>
            }
          />
        ))}
      </div>
    </Page>
  );
}
