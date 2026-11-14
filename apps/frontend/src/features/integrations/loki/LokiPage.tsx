import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { LokiIntegrationStatus } from "@nightwarden/shared";

import { Input } from "@/shared/ui/input";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { toast } from "@/shared/lib/toast";
import { api, dataOrThrow } from "@/shared/api/client";
import {
  rowLabel,
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsRow";
import {
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
import { lokiStatusQuery } from "../queries";

const identity = INTEGRATION_CATALOG.loki;
const LEAD = "Where NightWarden reads logs from, dialled from its own machine.";

function ConnectForm({
  status,
  onDone,
}: {
  status: LokiIntegrationStatus;
  onDone?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  // Only what is not secret comes back; the header is typed again or left off.
  const [url, setUrl] = useState(status.url ?? "");
  const [authHeader, setAuthHeader] = useState("");
  const [orgId, setOrgId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/integrations/loki", {
          body: {
            url: url.trim(),
            ...(authHeader.trim() && { authHeader: authHeader.trim() }),
            ...(orgId.trim() && { orgId: orgId.trim() }),
          },
        }),
      ),
    onMutate: () => setError(null),
    onSuccess: async () => {
      toast.success(status.configured ? "Loki updated" : "Loki connected");
      await queryClient.invalidateQueries({
        queryKey: lokiStatusQuery().queryKey,
      });
      onDone?.();
    },
    onError: (err) => setError(connectMessage(err)),
  });

  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup title="Connection" lead={LEAD}>
        <SettingsRow
          id="loki-url"
          title="Loki URL"
          description="Reachable from the NightWarden host."
        >
          <Input
            aria-labelledby={rowLabel("loki-url")}
            measure="beside"
            placeholder="http://loki.internal:3100"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
        </SettingsRow>
        <SettingsRow
          id="loki-auth"
          title="Authorization header"
          description="The whole header value, scheme included."
        >
          <Input
            aria-labelledby={rowLabel("loki-auth")}
            type="password"
            measure="beside"
            placeholder="Bearer ..."
            value={authHeader}
            onChange={(e) => setAuthHeader(e.currentTarget.value)}
          />
        </SettingsRow>
        <SettingsRow
          id="loki-org"
          title="Tenant"
          description="The tenant to read, sent as X-Scope-OrgID."
        >
          <Input
            aria-labelledby={rowLabel("loki-org")}
            measure="beside"
            placeholder="my-tenant"
            value={orgId}
            onChange={(e) => setOrgId(e.currentTarget.value)}
          />
        </SettingsRow>
      </SettingsGroup>
      <ConnectFooter
        error={error}
        label={status.configured ? "Update" : "Connect"}
        disabled={url.trim() === "" || connect.isPending}
        onConnect={() => connect.mutate()}
        {...(onDone !== undefined && { onCancel: onDone })}
      />
    </div>
  );
}

export function LokiPage(): React.JSX.Element {
  const { data: status } = useSuspenseQuery(lokiStatusQuery());
  const [updating, setUpdating] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const disconnect = useDisconnect({
    label: "Loki",
    queryKey: lokiStatusQuery().queryKey,
    request: () => dataOrThrow(api.DELETE("/api/integrations/loki")),
  });
  const test = useTestConnection({
    label: "Loki",
    queryKey: lokiStatusQuery().queryKey,
    request: () => dataOrThrow(api.POST("/api/integrations/loki/test")),
  });

  return (
    <IntegrationPage
      identity={identity}
      facts={metaFacts(identity)}
      state={credentialState(status.configured, status.rejection)}
      rejection={status.rejection}
    >
      {!status.configured || updating ? (
        <ConnectForm
          status={status}
          {...(updating && { onDone: () => setUpdating(false) })}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <SettingsGroup title="Connection" lead={LEAD}>
            <ValueRow id="loki-endpoint" title="Endpoint">
              {status.url}
            </ValueRow>
            <ValueRow id="loki-auth-state" title="Authorization">
              {status.hasAuth ? "Header stored" : "None"}
            </ValueRow>
            <ValueRow id="loki-tenant-state" title="Tenant">
              {status.hasOrgId ? "Stored" : "None"}
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
        title="Disconnect Loki?"
        description="Investigations lose log evidence until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </IntegrationPage>
  );
}
