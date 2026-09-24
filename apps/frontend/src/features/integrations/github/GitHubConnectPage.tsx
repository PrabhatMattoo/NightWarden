import { useEffect, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { CircleCheckIcon, ExternalLink, RefreshCw } from "lucide-react";
import type {
  GitHubErrorBody,
  GitHubIntegrationStatus,
  GitHubRepoSummary,
} from "@nightwarden/shared";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { MetaText } from "@/shared/ui/status";
import { Button, buttonVariants } from "@/shared/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/shared/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Waiting } from "@/shared/ui/Rounds";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { Page } from "@/shared/ui/Page";
import { expiryDaysFrom } from "@/features/integrations/github/useGitHubExpiryDays";
import { ICON_UI } from "@/shared/lib/iconProps";
import { toast } from "@/shared/lib/toast";
import { ApiError, apiFetch } from "@/shared/api/client";
import { INTEGRATION_CATALOG } from "../catalog";
import { IntegrationHeader } from "@/features/integrations/IntegrationHeader";
import { useDisconnect } from "../useIntegration";
import {
  fetchGitHubRepos,
  githubPreflightQuery,
  githubReposQuery,
  githubStatusQuery,
} from "../queries";

/* Repo selection stays on GitHub's own picker, the user's deliberate consent
   moment; no `issues` permission since NightWarden opens PRs, not issues. */
const FINE_GRAINED_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new" +
  "?name=NightWarden" +
  "&description=NightWarden%20proposes%20fixes%20as%20draft%20pull%20requests" +
  "&expires_in=90&contents=write&pull_requests=write";

/* Escape hatch for orgs that block fine-grained PATs entirely. */
const CLASSIC_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo&description=NightWarden";

const TYPED_REPOS_KEY = githubReposQuery("typed").queryKey;

/* Both ends of this contract are ours: the route answers with GitHubErrorBody,
   which is what the ladder below branches on. */
function errorBody(err: unknown): Partial<GitHubErrorBody> {
  if (!(err instanceof ApiError)) return {};
  if (typeof err.body !== "object" || err.body === null) return {};
  return err.body as Partial<GitHubErrorBody>;
}

const githubPost = <T,>(url: string, payload: unknown): Promise<T> =>
  apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const githubPatch = <T,>(url: string, payload: unknown): Promise<T> =>
  apiFetch<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

interface LadderContent {
  // Something to act on is a warning; a failure nothing here can fix is red.
  tone: "warning" | "destructive";
  title: string;
  detail: string;
  showRegenerate: boolean;
  orgApprovalUrl?: string;
}

/* The deterministic error ladder: one rendering per signal, honest about
   GitHub's deliberate 404 ambiguity. */
function ladderContent(err: unknown): LadderContent {
  const body = errorBody(err);
  if (err instanceof ApiError) {
    switch (body.code) {
      case "invalid_token":
        return {
          tone: "warning",
          title: "Token invalid or expired",
          detail:
            "GitHub rejected the token. Regenerate it and paste the new one.",
          showRegenerate: true,
        };
      case "sso_required":
        return {
          tone: "warning",
          title: "SSO authorization required",
          detail:
            "Authorize this token for your organization's SSO on GitHub, then try again.",
          showRegenerate: false,
        };
      case "repo_not_found":
        return {
          tone: "warning",
          title: "Repository not reachable",
          detail:
            body.orgApprovalUrl !== undefined
              ? "The repository may have been renamed or deleted, access revoked - or the token may be waiting on organization approval."
              : "The repository may have been renamed or deleted, or the token's access revoked.",
          showRegenerate: false,
          ...(body.orgApprovalUrl !== undefined && {
            orgApprovalUrl: body.orgApprovalUrl,
          }),
        };
      // Reachable and authenticated, so neither a retry nor a new token helps.
      case "bad_response":
        return {
          tone: "destructive",
          title: "GitHub answered in a shape NightWarden cannot read",
          detail: err.message,
          showRegenerate: false,
        };
      default:
        return {
          tone: "destructive",
          title: "GitHub unreachable",
          detail: err.message,
          showRegenerate: false,
        };
    }
  }
  return {
    tone: "destructive",
    title: "Request failed",
    detail: err instanceof Error ? err.message : "Try again.",
    showRegenerate: false,
  };
}

function LadderAlert({ error }: { error: unknown }): React.JSX.Element {
  const content = ladderContent(error);
  return (
    <Alert variant={content.tone}>
      <AlertTitle>{content.title}</AlertTitle>
      <AlertDescription>
        <span>{content.detail}</span>
        <span className="flex gap-2">
          {content.showRegenerate && (
            <a
              href={FINE_GRAINED_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              className="link external"
            >
              Regenerate token on GitHub
            </a>
          )}
          {content.orgApprovalUrl !== undefined && (
            <a
              href={content.orgApprovalUrl}
              target="_blank"
              rel="noreferrer"
              className="link external"
            >
              Review pending token requests
            </a>
          )}
        </span>
      </AlertDescription>
    </Alert>
  );
}

/* Advisory, not a gate: the sandbox is what a code session needs, and a host
   missing it can still finish connecting and fix the host afterwards. */
function PreflightWarning({ issue }: { issue: string }): React.JSX.Element {
  return (
    <Alert variant="warning">
      <AlertTitle>Code sandbox prerequisites missing</AlertTitle>
      <AlertDescription>
        {issue}. You can finish connecting, but code sessions will fail until
        this is fixed on the API host.
      </AlertDescription>
    </Alert>
  );
}

// Refresh sits beside the label rather than under the list, because the reason
// to press it is the reason the list is wrong.
function RepoCombobox({
  repos,
  selected,
  onSelect,
  refreshing,
  onRefresh,
}: {
  repos: GitHubRepoSummary[];
  selected: string | null;
  onSelect: (value: string | null) => void;
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <Field>
      <div className="flex items-center gap-2">
        <FieldLabel htmlFor="github-repo">Choose the repository</FieldLabel>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh repositories"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw {...ICON_UI} />
        </Button>
      </div>
      <Combobox
        items={repos.map((r) => r.fullName)}
        value={selected}
        onValueChange={onSelect}
      >
        <ComboboxInput
          id="github-repo"
          placeholder="Search repositories"
          className="w-full"
        />
        <ComboboxContent>
          <ComboboxList>
            <ComboboxEmpty>No repositories match.</ComboboxEmpty>
            {repos.map((r) => (
              <ComboboxItem key={r.fullName} value={r.fullName}>
                <span className="min-w-0 truncate font-mono">{r.fullName}</span>
                {r.private && <MetaText>Private</MetaText>}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldDescription>
        A repository owned by an organization appears only once an admin has
        approved the token. Refresh once that is done.
      </FieldDescription>
    </Field>
  );
}

export function GitHubConnectPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: status } = useSuspenseQuery(githubStatusQuery());
  const { data: preflight } = useSuspenseQuery(githubPreflightQuery());
  const configured = status.configured;

  const [token, setToken] = useState("");
  const [changingToken, setChangingToken] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const preflightIssue =
    preflight !== null && !preflight.ok
      ? (preflight.reason ?? "Sandbox prerequisites are missing")
      : null;

  const usingFreshToken = token.trim() !== "";
  const storedKey = githubReposQuery("stored").queryKey;
  const typedOptions = githubReposQuery("typed", token);

  // Never while a typed token is in the box: reloading from the stored
  // credential would wipe the validation error the user still has to read.
  const stored = useInfiniteQuery({
    ...githubReposQuery("stored"),
    enabled: configured && !usingFreshToken,
  });
  // Filled only by Validate, so typing never asks GitHub on its own.
  const typed = useInfiniteQuery({ ...typedOptions, enabled: false });
  const list = usingFreshToken ? typed : stored;
  const repos = list.data?.pages.flatMap((page) => page.repos) ?? null;

  // A validated token belongs to this visit only, as the typed token does.
  useEffect(
    () => () => queryClient.removeQueries({ queryKey: TYPED_REPOS_KEY }),
    [queryClient],
  );

  const validate = useMutation({
    mutationFn: () => fetchGitHubRepos(1, token),
    onMutate: () => {
      connectWithToken.reset();
      updateRepoOnly.reset();
    },
    onSuccess: (page) => {
      queryClient.setQueryData(typedOptions.queryKey, {
        pages: [page],
        pageParams: [1],
      });
      // A good token supersedes whatever the stored one last answered.
      queryClient.removeQueries({ queryKey: storedKey });
      setPicked(null);
      setChangingToken(false);
      toast.success("Token validated");
    },
    onError: () =>
      queryClient.removeQueries({ queryKey: typedOptions.queryKey }),
  });

  /* Full (re)bind: the only path that ever sends a token, so the only one that
     can replace the stored credential. */
  const connectWithToken = useMutation({
    mutationFn: (repo: string) =>
      githubPost<GitHubIntegrationStatus>("/api/integrations/github", {
        token,
        repo,
      }),
    onMutate: () => validate.reset(),
    onSuccess: async () => {
      // The list just validated is now the stored credential's, so it stays on screen.
      const validated = queryClient.getQueryData(typedOptions.queryKey);
      if (validated !== undefined)
        queryClient.setQueryData(storedKey, validated);
      toast.success(
        configured ? "GitHub repository updated" : "GitHub connected",
      );
      setToken("");
      setChangingToken(false);
      await queryClient.invalidateQueries({
        queryKey: githubStatusQuery().queryKey,
      });
    },
  });

  /* Repo-only rebind: never sends a token, so the stored credential is the only
     one that can be used here. */
  const updateRepoOnly = useMutation({
    mutationFn: (repo: string) =>
      githubPatch<GitHubIntegrationStatus>("/api/integrations/github", {
        repo,
      }),
    onMutate: () => validate.reset(),
    onSuccess: async () => {
      toast.success("GitHub repository updated");
      await queryClient.invalidateQueries({
        queryKey: githubStatusQuery().queryKey,
      });
    },
  });

  const disconnect = useDisconnect({
    label: "GitHub",
    queryKey: githubStatusQuery().queryKey,
    endpoint: () => "/api/integrations/github",
  });

  // The latest action's failure first, then whatever GitHub last said of the list.
  const error: Error | null =
    connectWithToken.error ??
    updateRepoOnly.error ??
    validate.error ??
    stored.error ??
    typed.error ??
    null;

  // A stored token GitHub has just rejected is no longer a connection to
  // summarise, so the input returns for a replacement rather than reading valid.
  const tokenRejected =
    error instanceof ApiError &&
    (errorBody(error).code === "invalid_token" ||
      errorBody(error).code === "sso_required");
  const showTokenInput =
    changingToken || (!configured && repos === null) || tokenRejected;
  // GitHub is asked whether the stored token still reaches a repo; until it
  // answers, nothing claims the token is valid.
  const checking =
    !changingToken && configured && !usingFreshToken && stored.isLoading;

  // The bound repo when the list still holds it, else the only one there is.
  const bound = usingFreshToken ? null : status.repo;
  const fallback =
    repos === null
      ? null
      : bound !== null && repos.some((r) => r.fullName === bound)
        ? bound
        : repos.length === 1
          ? (repos[0]?.fullName ?? null)
          : null;
  const selected = picked ?? fallback;

  function tokenSummaryText(): string {
    if (!usingFreshToken && configured) {
      const days = expiryDaysFrom(status);
      if (days !== null) {
        if (days <= 0) return "Validated - token expired";
        return `Validated - expires in ${String(days)} day${days === 1 ? "" : "s"}`;
      }
    }
    return "Validated";
  }

  const connecting = connectWithToken.isPending || updateRepoOnly.isPending;

  return (
    <Page measure="wide" back={{ to: "/integrations", label: "Integrations" }}>
      <div className="flex flex-col gap-8">
        <IntegrationHeader identity={INTEGRATION_CATALOG.github} />
        {preflightIssue !== null && <PreflightWarning issue={preflightIssue} />}

        <Field>
          <FieldLabel htmlFor="github-token">Personal access token</FieldLabel>
          <FieldDescription>
            Create a fine-grained token, grant it the one repository, and paste
            it here.
            <br />
            If your organization blocks fine-grained tokens, create a{" "}
            <a
              href={CLASSIC_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              className="link external"
            >
              classic token
            </a>{" "}
            with repo scope instead.
          </FieldDescription>
          {checking ? (
            <Waiting className="mt-2">Checking the token with GitHub…</Waiting>
          ) : showTokenInput ? (
            <div className="mt-2 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* A link drawn as a button: it opens GitHub, so it keeps a link's semantics. */}
                <a
                  href={FINE_GRAINED_TOKEN_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({
                    size: "sm",
                    variant: "secondary",
                  })}
                >
                  <ExternalLink {...ICON_UI} />
                  Create token on GitHub
                </a>
              </div>
              <div className="flex gap-2">
                <Input
                  id="github-token"
                  type="password"
                  measure="field"
                  placeholder="Paste token"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <Button
                  disabled={token.trim() === "" || validate.isPending}
                  onClick={() => validate.mutate()}
                >
                  Validate
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 type-body">
              <CircleCheckIcon {...ICON_UI} className="text-ok" />
              <span>{tokenSummaryText()}</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setChangingToken(true)}
              >
                Change
              </Button>
            </div>
          )}
        </Field>

        {error !== null && <LadderAlert error={error} />}

        {!showTokenInput &&
          repos !== null &&
          (repos.length === 0 ? (
            <FieldDescription>
              The token can reach no repositories. If you granted one owned by
              an organization, an admin has to approve the token first.
            </FieldDescription>
          ) : (
            /* The two buttons sit outside the Field: it is for a control and its
               words, and it stretches whatever it holds to the column width. */
            <div className="flex flex-col gap-4">
              <RepoCombobox
                repos={repos}
                selected={selected}
                onSelect={setPicked}
                refreshing={validate.isPending || list.isFetching}
                onRefresh={() => {
                  setPicked(null);
                  if (usingFreshToken) validate.mutate();
                  else void stored.refetch();
                }}
              />
              {list.hasNextPage && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  disabled={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  Load more
                </Button>
              )}
              <Button
                className="self-start"
                disabled={
                  selected === null ||
                  connecting ||
                  (configured && !usingFreshToken && selected === status.repo)
                }
                onClick={() => {
                  if (selected === null) return;
                  if (usingFreshToken) connectWithToken.mutate(selected);
                  else updateRepoOnly.mutate(selected);
                }}
              >
                {configured ? "Update repository" : "Connect repository"}
              </Button>
            </div>
          ))}

        {/* A destructive escape, not the task: it recedes below a divider so it
            never competes with reconnecting. */}
        {configured && (
          <div className="border-t-hairline border-edge pt-4">
            <Button
              size="sm"
              variant="destructive-ghost"
              className="self-start"
              disabled={disconnect.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              Disconnect GitHub
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect GitHub?"
        description={`This deletes NightWarden's stored copy of the token and unbinds ${status.repo ?? "the repository"}. The token itself stays valid until you revoke it on GitHub.`}
        confirmLabel="Disconnect"
        destructive
        onConfirm={() =>
          disconnect.mutate(undefined, {
            // Nothing a revoked credential could reach should reappear on reconnecting.
            onSuccess: () =>
              queryClient.removeQueries({
                queryKey: ["integrations", "github", "repos"],
              }),
          })
        }
      />
    </Page>
  );
}
