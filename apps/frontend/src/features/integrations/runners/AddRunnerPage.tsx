import { useState } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import type { MintedToken, Platform } from "@nightwarden/shared";
import { serverNameError } from "@nightwarden/shared";

import { Alert, AlertTitle, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { CopyableSnippet } from "@/shared/ui/CopyableSnippet";
import { FieldError } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Waiting } from "@/shared/ui/Rounds";
import { Section } from "@/shared/ui/Page";
import { ApiError, api, dataOrThrow } from "@/shared/api/client";
import {
  rowLabel,
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsRow";
import { ServerCard } from "@/features/integrations/runners/ServerCard";
import {
  ConnectionActions,
  IntegrationPage,
  metaFacts,
  NOT_CONNECTED,
  ValueRow,
  type ConnectionState,
} from "../IntegrationPage";
import { INTEGRATION_CATALOG } from "../catalog";
import { runnersQuery } from "../queries";
import { connectedOn } from "./connectedOn";
import { PLATFORM_COPY } from "./RunnerListPage.js";

const RUNNER_POLL_MS = 3000;

const WAITING: ConnectionState = {
  tone: "run",
  label: "Waiting for the runner",
};
const CONNECTED: ConnectionState = { tone: "ok", label: "Connected" };

/* One page that grows as the server is set up: the name, then the install
   command for that name, then what the runner sees once it dials in. */
export function AddRunnerPage({
  platform,
}: {
  platform: Platform;
}): React.JSX.Element {
  const navigate = useNavigate();
  const copy = PLATFORM_COPY[platform];
  const identity = INTEGRATION_CATALOG[platform];
  const listPath = `/integrations/${platform}`;

  const [serverName, setServerName] = useState("");
  const [touched, setTouched] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [committed, setCommitted] = useState(false);

  // The same rule the mint route enforces, so a name passing here cannot come
  // back a 400. Shown once typing starts: an untouched field is not a mistake.
  const nameError = serverNameError(serverName);
  const shownError = touched ? nameError : null;

  // Polled only while waiting for the new runner to dial in.
  const { data: runners } = useSuspenseQuery({
    ...runnersQuery(),
    refetchInterval:
      mintedToken !== null && !committed ? RUNNER_POLL_MS : false,
  });

  const connectedRunner = runners.find(
    (r) => r.id === mintedToken?.id && r.online && r.hostname !== null,
  );

  // With nothing to list, back skips the list page so a first install returns
  // to Integrations rather than an empty intermediary.
  const back =
    connectedOn(runners, platform).length > 0
      ? { to: listPath, label: copy.plural }
      : { to: "/integrations", label: "Integrations" };

  /* The token is kept as soon as it exists, so leaving before the script arrives
     still revokes it. A taken name leaves the name open to change. */
  const prepare = useMutation({
    mutationFn: async () => {
      const minted = await dataOrThrow(
        api.POST("/api/tokens", {
          body: { platform, serverName: serverName.trim() },
        }),
      );
      setMintedToken(minted);
      // One endpoint for both platforms: the row the token names picks the artifact.
      return await dataOrThrow(
        api.GET("/api/runners/install", {
          headers: { Authorization: `Bearer ${minted.token}` },
          parseAs: "text",
        }),
      );
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) setMintedToken(null);
    },
  });
  const installText = prepare.data ?? null;
  const installError = prepare.error?.message ?? null;

  // Read from the manifest the runner already sent: nothing is dispatched, so
  // checking the wiring cannot start an investigation or spend a token.
  const advertised = (connectedRunner?.manifest?.services ?? []).map(
    (entry) => entry.target,
  );

  // Sticky once the runner has dialled in: its token is spent, so leaving is safe.
  if (connectedRunner && !committed) setCommitted(true);

  const tokenPending = mintedToken !== null && !committed;
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    disabled: !tokenPending,
    enableBeforeUnload: () => tokenPending,
    withResolver: true,
  });

  // Best effort: leaving never waits on it.
  const revoke = useMutation({
    mutationFn: (id: string) =>
      dataOrThrow(api.DELETE("/api/tokens/{id}", { params: { path: { id } } })),
  });

  // A different name needs a different token, so the one already minted goes.
  function startOver(): void {
    if (mintedToken !== null) revoke.mutate(mintedToken.id);
    setMintedToken(null);
    prepare.reset();
  }

  function confirmLeaveSetup(): void {
    if (mintedToken !== null) revoke.mutate(mintedToken.id);
    if (blocker.status === "blocked") blocker.proceed();
  }

  function cancelLeaveSetup(): void {
    if (blocker.status === "blocked") blocker.reset();
  }

  const named = mintedToken !== null || prepare.isPending;
  const state = connectedRunner
    ? CONNECTED
    : mintedToken !== null
      ? WAITING
      : NOT_CONNECTED;

  return (
    <IntegrationPage
      identity={identity}
      facts={metaFacts(identity)}
      state={state}
      back={back}
    >
      <div className="flex flex-col gap-3">
        <SettingsGroup
          title="Name"
          lead={`What NightWarden calls this ${copy.singular}.`}
        >
          {named ? (
            <ValueRow id="server-name" title="Server name">
              {serverName.trim()}
            </ValueRow>
          ) : (
            <SettingsRow
              id="server-name"
              title="Server name"
              description="The first part of every service address. Must be unique."
            >
              <Input
                aria-labelledby={rowLabel("server-name")}
                measure="beside"
                placeholder={
                  platform === "docker" ? "prod-web-01" : "prod-cluster"
                }
                value={serverName}
                aria-invalid={shownError !== null}
                onChange={(e) => {
                  setTouched(true);
                  setServerName(e.currentTarget.value);
                }}
              />
            </SettingsRow>
          )}
        </SettingsGroup>
        {!named && (
          <div className="flex items-center gap-3">
            <FieldError>{shownError ?? installError}</FieldError>
            <Button
              className="ml-auto"
              disabled={nameError !== null}
              onClick={() => prepare.mutate()}
            >
              Generate install command
            </Button>
          </div>
        )}
      </div>

      {named && (
        <div className="flex flex-col gap-3">
          <SettingsGroup
            title="Install"
            lead={
              platform === "docker"
                ? "Run this on the host. The runner dials out to NightWarden, so nothing needs to reach in."
                : "Apply this to the cluster. The runner dials out to NightWarden, so nothing needs to reach in."
            }
          >
            <SettingsRow id="install-command" title="Install command" stacked>
              {installText !== null ? (
                <CopyableSnippet
                  text={installText}
                  label="Copy install command"
                />
              ) : installError !== null ? (
                <FieldError>{installError}</FieldError>
              ) : (
                <Waiting>Generating a runner token…</Waiting>
              )}
            </SettingsRow>
          </SettingsGroup>
          {!connectedRunner && (
            <ConnectionActions>
              <Button variant="secondary" onClick={startOver}>
                Change the name
              </Button>
            </ConnectionActions>
          )}
        </div>
      )}

      {connectedRunner && (
        <Section
          title="What it sees"
          lead="An alert reaches a service by carrying labels that match one of these keys."
        >
          {advertised.length === 0 && (
            <Alert variant="warning">
              <AlertTitle>No services detected</AlertTitle>
              <AlertDescription>{copy.emptyHint}</AlertDescription>
            </Alert>
          )}
          <ServerCard runner={connectedRunner} defaultServicesOpen />
          <ConnectionActions>
            <Button onClick={() => void navigate({ to: listPath })}>
              Done
            </Button>
          </ConnectionActions>
        </Section>
      )}

      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o) cancelLeaveSetup();
        }}
        title="Leave setup?"
        description="The runner token you generated will be revoked."
        confirmLabel="Leave setup"
        destructive
        onConfirm={confirmLeaveSetup}
      />
    </IntegrationPage>
  );
}
