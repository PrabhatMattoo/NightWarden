import { useState } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import type { Platform } from "@nightwarden/shared";
import { serverNameError } from "@nightwarden/shared";
import { ServerCard } from "@/features/integrations/runners/ServerCard";
import { AlertCircle } from "lucide-react";

import { Alert, AlertTitle, AlertDescription } from "@/shared/ui/alert";
import { StatusText } from "@/shared/ui/status";
import { Button } from "@/shared/ui/button";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Waiting } from "@/shared/ui/Rounds";
import { Page } from "@/shared/ui/Page";
import {
  WizardStepper,
  WizardActions,
} from "@/features/integrations/runners/WizardStepper";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { CopyableSnippet } from "@/shared/ui/CopyableSnippet";
import { ICON_UI } from "@/shared/lib/iconProps";
import { ApiError, apiFetch, apiText } from "@/shared/api/client";
import { runnersQuery } from "../queries";
import { connectedOn } from "./connectedOn";
import { PLATFORM_COPY } from "./RunnerListPage.js";

interface MintedToken {
  id: string;
  token: string;
}

const RUNNER_POLL_MS = 3000;

// One endpoint for both: the platform was stored when the token was minted, so
// the artifact that comes back is the one this runner's row already names.
const INSTALL_URL = "/api/runners/install";

export function AddRunnerPage({
  platform,
}: {
  platform: Platform;
}): React.JSX.Element {
  const navigate = useNavigate();
  const copy = PLATFORM_COPY[platform];
  const listPath = `/integrations/${platform}`;

  const [step, setStep] = useState(0);
  const [serverName, setServerName] = useState("");
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [committed, setCommitted] = useState(false);
  const [touched, setTouched] = useState(false);

  const STEP_TITLES = ["Name it", "Install the runner", "Confirm what it sees"];

  // The same rule the mint route enforces, so a name passing here cannot come
  // back a 400. Shown once typing starts: an untouched field is not a mistake.
  const nameError = serverNameError(serverName);
  const shownError = touched ? nameError : null;

  // Polled only while waiting for the new runner to dial in.
  const { data: runners } = useSuspenseQuery({
    ...runnersQuery(),
    refetchInterval:
      step === 1 && mintedToken !== null ? RUNNER_POLL_MS : false,
  });

  const connectedRunner = runners.find(
    (r) => r.id === mintedToken?.id && r.online && r.hostname !== null,
  );

  // With nothing to list, back skips the list page so a first install returns
  // to Integrations rather than an empty intermediary.
  const hasConnected = connectedOn(runners, platform).length > 0;
  const back = hasConnected
    ? { to: listPath, label: copy.plural }
    : { to: "/integrations", label: "Integrations" };

  /* The token is kept as soon as it exists, so leaving before the script arrives
     still revokes it. A taken name sends the person back to the name step. */
  const prepare = useMutation({
    mutationFn: async () => {
      const minted = await apiFetch<MintedToken>("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, serverName: serverName.trim() }),
      });
      setMintedToken(minted);
      return await apiText(INSTALL_URL, {
        headers: { Authorization: `Bearer ${minted.token}` },
      });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) setStep(0);
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
      apiFetch<void>(`/api/tokens/${id}`, { method: "DELETE" }),
  });

  function confirmLeaveSetup(): void {
    if (mintedToken !== null) revoke.mutate(mintedToken.id);
    if (blocker.status === "blocked") blocker.proceed();
  }

  function cancelLeaveSetup(): void {
    if (blocker.status === "blocked") blocker.reset();
  }

  function handleStartInstall(): void {
    if (nameError !== null) return;
    setStep(1);
    prepare.mutate();
  }

  return (
    <Page measure="wide" back={back}>
      <WizardStepper step={step} total={3} title={STEP_TITLES[step]} />

      {step === 0 && (
        <div className="flex flex-col gap-8">
          <Field>
            <FieldLabel htmlFor="server-name">Server name</FieldLabel>
            <FieldDescription>
              The name NightWarden addresses this {copy.singular.toLowerCase()}{" "}
              by, and the first part of every service address. Must be unique.
            </FieldDescription>
            <Input
              measure="short"
              id="server-name"
              placeholder={
                platform === "docker" ? "e.g. prod-web-01" : "e.g. prod-cluster"
              }
              value={serverName}
              aria-invalid={shownError !== null}
              onChange={(e) => {
                setTouched(true);
                setServerName(e.currentTarget.value);
              }}
            />
            {/* Always present: a row that appears on error shifts the form. */}
            <div className="min-h-5">
              {shownError && (
                <FieldError>
                  <AlertCircle {...ICON_UI} />
                  {shownError}
                </FieldError>
              )}
            </div>
          </Field>

          {installError !== null && (
            <FieldError>
              <AlertCircle {...ICON_UI} />
              {installError}
            </FieldError>
          )}

          <WizardActions>
            <Button
              className="ml-auto"
              disabled={nameError !== null}
              onClick={handleStartInstall}
            >
              Continue
            </Button>
          </WizardActions>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-4">
          {prepare.isPending && <Waiting>Generating a runner token…</Waiting>}

          {installError !== null && (
            <FieldError>
              <AlertCircle {...ICON_UI} />
              {installError}
            </FieldError>
          )}

          {installText !== null && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <p className="type-body">
                  {platform === "docker"
                    ? "Run this on the host to install the runner:"
                    : "Apply this to the cluster to install the runner:"}
                </p>
                <CopyableSnippet
                  text={installText}
                  label="Copy install command"
                />
              </div>

              <div className="flex items-center gap-2">
                {connectedRunner ? (
                  <StatusText tone="ok">Runner connected</StatusText>
                ) : (
                  <Waiting>Waiting for the runner to connect…</Waiting>
                )}
              </div>
            </div>
          )}

          <WizardActions>
            <Button variant="outline" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button disabled={!connectedRunner} onClick={() => setStep(2)}>
              Continue
            </Button>
          </WizardActions>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <p className="type-body">
            What this runner advertises. An alert reaches a service by carrying
            labels that match one of these keys.
          </p>

          {advertised.length === 0 && (
            <Alert variant="warning">
              <AlertTitle>No services detected</AlertTitle>
              <AlertDescription>{copy.emptyHint}</AlertDescription>
            </Alert>
          )}

          {connectedRunner && (
            <ServerCard runner={connectedRunner} defaultServicesOpen />
          )}

          <WizardActions>
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: listPath })}
            >
              Done
            </Button>
          </WizardActions>
        </div>
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
    </Page>
  );
}
