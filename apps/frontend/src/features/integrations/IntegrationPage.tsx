/* One page serves every integration: who it is, a card saying what it gives and
   whether it is connected, then its sections, with their actions below them. */

import type { CredentialRejection } from "@nightwarden/shared";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Page } from "@/shared/ui/Page";
import { StatusText, type StatusTone } from "@/shared/ui/status";
import { cn } from "@/shared/lib/utils";
import { dayClock } from "@/shared/lib/time";
import { rowLabel, SettingsRow } from "@/features/settings/SettingsRow";
import type { IntegrationIdentity } from "./catalog";

const LOGO_SIZE = {
  tile: { box: "size-9", img: "size-5" },
  header: { box: "size-10.5", img: "size-6" },
} as const;

// White, because vendor logos are drawn for a light ground.
export function IntegrationLogo({
  logo,
  size = "tile",
}: {
  logo: string;
  size?: keyof typeof LOGO_SIZE;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-control bg-logo-tile text-ground",
        LOGO_SIZE[size].box,
      )}
    >
      <img src={logo} alt="" className={LOGO_SIZE[size].img} />
    </span>
  );
}

export interface MetaFact {
  key: string;
  content: React.ReactNode;
}

export interface ConnectionState {
  tone: StatusTone;
  label: string;
}

export const NOT_CONNECTED: ConnectionState = {
  tone: "muted",
  label: "Not connected",
};

// Connected, unless the third party has refused what is stored.
export function credentialState(
  configured: boolean,
  rejection: CredentialRejection | null,
): ConnectionState {
  if (!configured) return NOT_CONNECTED;
  return rejection === null
    ? { tone: "ok", label: "Connected" }
    : { tone: "warn", label: "Needs attention" };
}

// What never changes with the connection: what it gives and where its docs are.
export function metaFacts(
  identity: IntegrationIdentity,
  extra: MetaFact[] = [],
): MetaFact[] {
  return [
    { key: "provides", content: identity.provides },
    ...extra,
    {
      key: "docs",
      content: (
        <a
          href={identity.docs.url}
          target="_blank"
          rel="noreferrer"
          className="link external"
        >
          {identity.docs.brand} docs
        </a>
      ),
    },
  ];
}

export function IntegrationPage({
  identity,
  facts,
  state,
  rejection = null,
  back = { to: "/integrations", label: "Integrations" },
  children,
}: {
  identity: IntegrationIdentity;
  facts: MetaFact[];
  // Said here and nowhere else on the page.
  state: ConnectionState;
  rejection?: CredentialRejection | null;
  back?: { to: string; label: string };
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Page back={back}>
      <div className="flex flex-col gap-8">
        {/* Top-aligned, so a line that wraps grows downward and never lifts the name off the logo. */}
        <header
          data-testid="integration-header"
          className="flex items-start gap-4"
        >
          <IntegrationLogo logo={identity.logo} size="header" />
          <span className="flex min-w-0 flex-col">
            <h1 className="type-name">{identity.label}</h1>
            <span className="type-body text-pretty text-ink-muted">
              {identity.tagline}
            </span>
          </span>
        </header>

        {/* One line at any width: the first fact gives way to an ellipsis before the line wraps. */}
        <Card>
          <div className="flex items-center gap-6 p-4 type-body text-ink-title">
            {facts.map((fact, i) => (
              <span
                key={fact.key}
                className={i === 0 ? "min-w-0 truncate" : "whitespace-nowrap"}
              >
                {fact.content}
              </span>
            ))}
            <StatusText tone={state.tone} className="ml-auto">
              {state.label}
            </StatusText>
          </div>
        </Card>

        {rejection !== null && (
          <Alert variant="warning">
            <AlertTitle>Needs attention</AlertTitle>
            <AlertDescription>
              {rejection.reason}, at {dayClock(rejection.at)}. Update the
              credentials, or test the connection again once the cause is fixed.
            </AlertDescription>
          </Alert>
        )}

        {children}
      </div>
    </Page>
  );
}

/* The actions under a section's card. Disconnect stands apart on the left, so the
   one irreversible action is never beside the ones that are safe to press. */
export function ConnectionActions({
  onDisconnect,
  children,
}: {
  onDisconnect?: () => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      {onDisconnect !== undefined && (
        <Button variant="destructive-ghost" onClick={onDisconnect}>
          Disconnect
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

// What a pulled-from connection offers once it stands: test it, replace what it holds, remove it.
export function CredentialActions({
  testing,
  onTest,
  updateLabel = "Update credentials",
  onUpdate,
  onDisconnect,
}: {
  testing: boolean;
  onTest: () => void;
  updateLabel?: string;
  onUpdate: () => void;
  onDisconnect: () => void;
}): React.JSX.Element {
  return (
    <ConnectionActions onDisconnect={onDisconnect}>
      <Button variant="secondary" disabled={testing} onClick={onTest}>
        Test connection
      </Button>
      <Button variant="secondary" onClick={onUpdate}>
        {updateLabel}
      </Button>
    </ConnectionActions>
  );
}

/* The foot of a connect form: what the probe said when it refused, then the one
   action, and Cancel only when an existing connection stands behind the form. */
export function ConnectFooter({
  error,
  label = "Connect",
  disabled,
  onConnect,
  onCancel,
}: {
  error: string | null;
  label?: string;
  disabled: boolean;
  onConnect: () => void;
  onCancel?: () => void;
}): React.JSX.Element {
  return (
    <>
      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>Could not connect</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ConnectionActions>
        {onCancel !== undefined && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button disabled={disabled} onClick={onConnect}>
          {label}
        </Button>
      </ConnectionActions>
    </>
  );
}

// A setting that is read here, not changed: its value stands where a control would.
export function ValueRow({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SettingsRow
      id={id}
      title={title}
      {...(description !== undefined && { description })}
    >
      <div
        aria-labelledby={rowLabel(id)}
        className="type-body text-pretty break-all"
      >
        {children}
      </div>
    </SettingsRow>
  );
}
