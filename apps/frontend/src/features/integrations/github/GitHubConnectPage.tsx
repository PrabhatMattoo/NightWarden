import { useEffect, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { GitHubErrorBody, GitHubRepoSummary } from "@nightwarden/shared";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { MetaText, StatusText } from "@/shared/ui/status";
import { Button, buttonVariants } from "@/shared/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/shared/ui/combobox";
import { Input } from "@/shared/ui/input";
import { Waiting } from "@/shared/ui/Rounds";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { expiryDaysFrom } from "@/features/integrations/github/useGitHubExpiryDays";
import { ICON_UI } from "@/shared/lib/iconProps";
import { toast } from "@/shared/lib/toast";
import { ApiError, api, dataOrThrow } from "@/shared/api/client";
import { INTEGRATION_CATALOG } from "../catalog";
import {
  rowLabel,
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsRow";
import {
  ConnectionActions,
  CredentialActions,
  credentialState,
  IntegrationPage,
  metaFacts,
} from "../IntegrationPage";
import { useDisconnect, useTestConnection } from "../useIntegration";
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

// Refresh sits beside the list rather than under it, because the reason to
// press it is the reason the list is wrong.
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
    <div className="flex w-full items-center gap-2">
      <Combobox
        items={repos.map((r) => r.fullName)}
        value={selected}
        onValueChange={onSelect}
      >
        <ComboboxInput
          aria-labelledby={rowLabel("github-repo")}
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
      <Button
        size="icon"
        variant="ghost"
        aria-label="Refresh repositories"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw {...ICON_UI} />
      </Button>
    </div>
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
      toast.success("GitHub accepted the token");
    },
    onError: () =>
      queryClient.removeQueries({ queryKey: typedOptions.queryKey }),
  });

  /* Full (re)bind: the only path that ever sends a token, so the only one that
     can replace the stored credential. */
  const connectWithToken = useMutation({
    mutationFn: (repo: string) =>
      dataOrThrow(
        api.POST("/api/integrations/github", { body: { token, repo } }),
      ),
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
      dataOrThrow(api.PATCH("/api/integrations/github", { body: { repo } })),
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
    request: () => dataOrThrow(api.DELETE("/api/integrations/github")),
  });
  const test = useTestConnection({
    label: "GitHub",
    queryKey: githubStatusQuery().queryKey,
    request: () => dataOrThrow(api.POST("/api/integrations/github/test")),
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

  const connecting = connectWithToken.isPending || updateRepoOnly.isPending;
  const days = configured && !usingFreshToken ? expiryDaysFrom(status) : null;
  const expired = days !== null && days <= 0;
  // A token that only passed its check has no connection yet, so its row asks for the repository.
  const saved = configured && !usingFreshToken;
  const tokenText = !saved
    ? "Choose the repository below"
    : days === null
      ? "No expiry date"
      : expired
        ? "Expired"
        : `Expires in ${String(days)} day${days === 1 ? "" : "s"}`;

  return (
    <IntegrationPage
      identity={INTEGRATION_CATALOG.github}
      facts={metaFacts(INTEGRATION_CATALOG.github)}
      state={credentialState(configured, status.rejection)}
      rejection={status.rejection}
    >
      {preflightIssue !== null && <PreflightWarning issue={preflightIssue} />}

      <div className="flex flex-col gap-3">
        <SettingsGroup
          title="Token"
          lead="Investigations read the repository, and open draft pull requests, with a personal access token you create."
        >
          <SettingsRow
            id="github-token"
            title="Personal access token"
            description="A fine-grained token granted the one repository."
            stacked={showTokenInput}
          >
            {checking ? (
              <Waiting>Checking the token with GitHub…</Waiting>
            ) : showTokenInput ? (
              <div className="flex flex-col gap-3">
                <p className="type-small">
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
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-labelledby={rowLabel("github-token")}
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
                  {/* A link drawn as a button: it opens GitHub, so it keeps a link's semantics. */}
                  <a
                    href={FINE_GRAINED_TOKEN_URL}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonVariants({ variant: "ghost" })}
                  >
                    <ExternalLink {...ICON_UI} />
                    Create token on GitHub
                  </a>
                </div>
              </div>
            ) : (
              <StatusText tone={expired ? "warn" : "muted"}>
                {tokenText}
              </StatusText>
            )}
          </SettingsRow>
        </SettingsGroup>

        {/* Under the card in every state, so connecting swaps the buttons in place. */}
        {checking ? null : showTokenInput ? (
          configured && (
            <ConnectionActions>
              <Button
                variant="secondary"
                onClick={() => {
                  setToken("");
                  setChangingToken(false);
                }}
              >
                Cancel
              </Button>
            </ConnectionActions>
          )
        ) : saved ? (
          <CredentialActions
            testing={test.isPending}
            onTest={() => test.mutate()}
            updateLabel="Change token"
            onUpdate={() => setChangingToken(true)}
            onDisconnect={() => setConfirmOpen(true)}
          />
        ) : (
          <ConnectionActions>
            <Button variant="secondary" onClick={() => setChangingToken(true)}>
              Change token
            </Button>
          </ConnectionActions>
        )}

        {error !== null && <LadderAlert error={error} />}
      </div>

      {!showTokenInput && repos !== null && (
        <div className="flex flex-col gap-3">
          <SettingsGroup
            title="Repository"
            lead="The one repository investigations read, and open pull requests against."
          >
            <SettingsRow
              id="github-repo"
              title="Repository"
              description={
                repos.length === 0
                  ? "The token can reach no repositories. If you granted one owned by an organization, an admin has to approve the token first."
                  : "One owned by an organization appears only once an admin has approved the token. Refresh once that is done."
              }
              stacked
            >
              {repos.length > 0 && (
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
              )}
            </SettingsRow>
          </SettingsGroup>
          {repos.length > 0 && (
            <div className="flex justify-end gap-2">
              {list.hasNextPage && (
                <Button
                  variant="secondary"
                  disabled={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  Load more
                </Button>
              )}
              <Button
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
          )}
        </div>
      )}

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
    </IntegrationPage>
  );
}
