import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { SentryIntegrationStatus } from "@nightwarden/shared";

import { Input } from "@/shared/ui/input";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { toast } from "@/shared/lib/toast";
import { api, dataOrThrow } from "@/shared/api/client";
import {
  rowLabel,
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsRow";
import { useCan } from "@/features/auth/useCan";
import {
  AdminsConnect,
  ConnectFooter,
  CredentialActions,
  credentialState,
  IntegrationPage,
  metaFacts,
  ValueRow,
} from "../IntegrationPage";
import {
  connectMessage,
  useDisconnect,
  useTestConnection,
} from "../useIntegration";
import { INTEGRATION_CATALOG } from "../catalog";
import { sentryStatusQuery } from "../queries";

const identity = INTEGRATION_CATALOG.sentry;
const LEAD =
  "The Sentry organization NightWarden reads exceptions and releases from.";

function ConnectForm({
  status,
  onDone,
}: {
  status: SentryIntegrationStatus;
  onDone?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  // The address and slug come back; the token never does, so it is typed again.
  const [url, setUrl] = useState(status.url ?? "");
  const [orgSlug, setOrgSlug] = useState(status.orgSlug ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/integrations/sentry", {
          body: {
            url: url.trim(),
            orgSlug: orgSlug.trim(),
            token: token.trim(),
          },
        }),
      ),
    onMutate: () => setError(null),
    onSuccess: async () => {
      toast.success(status.configured ? "Sentry updated" : "Sentry connected");
      await queryClient.invalidateQueries({
        queryKey: sentryStatusQuery().queryKey,
      });
      onDone?.();
    },
    onError: (err) => setError(connectMessage(err)),
  });

  const incomplete =
    url.trim() === "" || orgSlug.trim() === "" || token.trim() === "";

  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup title="Connection" lead={LEAD}>
        <SettingsRow
          id="sentry-url"
          title="Sentry URL"
          description="The base address, without the /api/0 path. sentry.io or self-hosted."
        >
          <Input
            aria-labelledby={rowLabel("sentry-url")}
            measure="beside"
            placeholder="https://sentry.example.com"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
        </SettingsRow>
        <SettingsRow
          id="sentry-org"
          title="Organization slug"
          description="The organization in the URL when you browse Sentry, not its display name."
        >
          <Input
            aria-labelledby={rowLabel("sentry-org")}
            measure="beside"
            placeholder="acme"
            value={orgSlug}
            onChange={(e) => setOrgSlug(e.currentTarget.value)}
          />
        </SettingsRow>
        <SettingsRow
          id="sentry-token"
          title="Auth token"
          description="An internal integration token with both event:read and project:read."
        >
          <Input
            aria-labelledby={rowLabel("sentry-token")}
            type="password"
            measure="beside"
            placeholder="sntrys_..."
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
          />
        </SettingsRow>
      </SettingsGroup>
      <ConnectFooter
        error={error}
        label={status.configured ? "Update" : "Connect"}
        disabled={incomplete || connect.isPending}
        onConnect={() => connect.mutate()}
        {...(onDone !== undefined && { onCancel: onDone })}
      />
    </div>
  );
}

export function SentryPage(): React.JSX.Element {
  const { data: status } = useSuspenseQuery(sentryStatusQuery());
  const canManage = useCan({ integration: ["manage"] });
  const [updating, setUpdating] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const disconnect = useDisconnect({
    label: "Sentry",
    queryKey: sentryStatusQuery().queryKey,
    request: () => dataOrThrow(api.DELETE("/api/integrations/sentry")),
  });
  const test = useTestConnection({
    label: "Sentry",
    queryKey: sentryStatusQuery().queryKey,
    request: () => dataOrThrow(api.POST("/api/integrations/sentry/test")),
  });

  return (
    <IntegrationPage
      identity={identity}
      facts={metaFacts(identity)}
      state={credentialState(status.configured, status.rejection)}
      rejection={status.rejection}
    >
      {!status.configured && !canManage ? (
        <AdminsConnect />
      ) : !status.configured || updating ? (
        <ConnectForm
          status={status}
          {...(updating && { onDone: () => setUpdating(false) })}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <SettingsGroup title="Connection" lead={LEAD}>
            <ValueRow id="sentry-base-url" title="Base URL">
              {status.url}
            </ValueRow>
            <ValueRow id="sentry-organization" title="Organization">
              {status.orgSlug}
            </ValueRow>
            <ValueRow id="sentry-token-state" title="Auth token">
              Stored
            </ValueRow>
          </SettingsGroup>
          <CredentialActions
            testing={test.isPending}
            onTest={() => test.mutate()}
            onUpdate={() => setUpdating(true)}
            onDisconnect={() => setConfirmDisconnect(true)}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Sentry?"
        description="Investigations lose exception and release evidence until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </IntegrationPage>
  );
}
