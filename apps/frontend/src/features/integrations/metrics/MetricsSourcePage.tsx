import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import type {
  MetricsConnectInput,
  MetricsEndpointInput,
  MetricsSourceKind,
  MetricsSourceStatus,
} from "@nightwarden/shared";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { IconLine } from "@/shared/ui/icon-line";
import { toast } from "@/shared/lib/toast";
import { api, dataOrThrow } from "@/shared/api/client";
import {
  rowLabel,
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsRow";
import { useCan } from "@/features/auth/useCan";
import { IntegrationWarnings } from "../IntegrationWarnings";
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
import {
  AUTH_LABEL,
  METRICS_SOURCE_CONTENT,
  QUERY_LEAD,
  RULES_LEAD,
  type AuthMethod,
} from "./content";
import { INTEGRATION_CATALOG } from "../catalog";
import { metricsSourceQuery } from "../queries";

// The method decides which fields travel, so a credential the user switched
// away from is never sent beside the one they chose.
interface Credential {
  method: AuthMethod;
  bearer: string;
  username: string;
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken: string;
}

const emptyCredential = (method: AuthMethod): Credential => ({
  method,
  bearer: "",
  username: "",
  password: "",
  accessKeyId: "",
  secretAccessKey: "",
  region: "",
  sessionToken: "",
});

const trim = (v: string): string => v.trim();

function endpointOf(
  url: string,
  credential: Credential,
  orgId: string,
): MetricsEndpointInput {
  const tenant = trim(orgId) === "" ? {} : { orgId: trim(orgId) };
  switch (credential.method) {
    case "bearer":
      return {
        url: trim(url),
        ...(trim(credential.bearer) && { authHeader: trim(credential.bearer) }),
        ...tenant,
      };
    case "basic":
      return {
        url: trim(url),
        ...(trim(credential.username) && {
          basicUsername: trim(credential.username),
        }),
        ...(trim(credential.password) && {
          basicPassword: trim(credential.password),
        }),
        ...tenant,
      };
    case "aws":
      return {
        url: trim(url),
        ...(trim(credential.accessKeyId) && {
          accessKeyId: trim(credential.accessKeyId),
        }),
        ...(trim(credential.secretAccessKey) && {
          secretAccessKey: trim(credential.secretAccessKey),
        }),
        ...(trim(credential.region) && { region: trim(credential.region) }),
        ...(trim(credential.sessionToken) && {
          sessionToken: trim(credential.sessionToken),
        }),
      };
    case "none":
      return { url: trim(url), ...tenant };
  }
}

/* Rows rather than a component, so the group they join draws a rule between
   each: a component would reach the group as one child. */
function credentialRows(
  idPrefix: string,
  credential: Credential,
  onChange: (next: Credential) => void,
): React.JSX.Element[] {
  const set = (patch: Partial<Credential>): void =>
    onChange({ ...credential, ...patch });
  const row = (
    key: keyof Credential,
    suffix: string,
    title: string,
    options: { secret?: boolean; placeholder?: string; description?: string },
  ): React.JSX.Element => {
    const id = `${idPrefix}-${suffix}`;
    return (
      <SettingsRow
        key={id}
        id={id}
        title={title}
        {...(options.description !== undefined && {
          description: options.description,
        })}
      >
        <Input
          aria-labelledby={rowLabel(id)}
          measure="beside"
          {...(options.secret === true && { type: "password" })}
          {...(options.placeholder !== undefined && {
            placeholder: options.placeholder,
          })}
          value={credential[key]}
          onChange={(e) => set({ [key]: e.currentTarget.value })}
        />
      </SettingsRow>
    );
  };

  switch (credential.method) {
    case "none":
      return [];
    case "bearer":
      return [
        row("bearer", "bearer", "Authorization header", {
          secret: true,
          placeholder: "Bearer ...",
          description: "The whole header value, scheme included.",
        }),
      ];
    case "basic":
      return [
        row("username", "user", "Username", {}),
        row("password", "pass", "Password", { secret: true }),
      ];
    case "aws":
      return [
        row("accessKeyId", "access-key", "Access key ID", {
          placeholder: "AKIA...",
        }),
        row("secretAccessKey", "secret-key", "Secret access key", {
          secret: true,
        }),
        row("region", "region", "Region", { placeholder: "us-east-1" }),
        row("sessionToken", "session-token", "Session token", {
          secret: true,
          description: "Only for temporary STS credentials.",
        }),
      ];
  }
}

// A product that offers one way in is not asking a question.
function authRow(
  id: string,
  methods: AuthMethod[],
  help: string,
  value: AuthMethod,
  onChange: (next: AuthMethod) => void,
): React.JSX.Element | null {
  if (methods.length < 2) return null;
  const items = Object.fromEntries(methods.map((m) => [m, AUTH_LABEL[m]]));
  return (
    <SettingsRow
      key={id}
      id={id}
      title="Authentication"
      {...(help !== "" && { description: help })}
    >
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          const method = methods.find((m) => m === next);
          if (method !== undefined) onChange(method);
        }}
      >
        <SelectTrigger aria-labelledby={rowLabel(id)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {methods.map((m) => (
            <SelectItem key={m} value={m}>
              {AUTH_LABEL[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

function ConnectForm({
  kind,
  status,
  onDone,
}: {
  kind: MetricsSourceKind;
  status: MetricsSourceStatus;
  onDone?: () => void;
}): React.JSX.Element {
  const content = METRICS_SOURCE_CONTENT[kind];
  const identity = INTEGRATION_CATALOG[kind];
  const queryClient = useQueryClient();
  const defaultMethod = content.auth[0] ?? "none";

  // The addresses come back on an update; every credential is typed again.
  const [queryUrl, setQueryUrl] = useState(status.query?.url ?? "");
  const [queryCredential, setQueryCredential] = useState(
    emptyCredential(defaultMethod),
  );
  const [orgId, setOrgId] = useState("");
  const [rulesUrl, setRulesUrl] = useState(status.rules?.url ?? "");
  const [sameCredential, setSameCredential] = useState(true);
  const [rulesCredential, setRulesCredential] = useState(
    emptyCredential(defaultMethod),
  );
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () => {
      const body: MetricsConnectInput = {
        kind,
        query: endpointOf(queryUrl, queryCredential, orgId),
        // Absent rather than empty: a source with no rules endpoint is a
        // supported configuration, and the Recovery row says what it costs.
        ...(trim(rulesUrl) !== "" && {
          rules: endpointOf(
            rulesUrl,
            sameCredential ? queryCredential : rulesCredential,
            orgId,
          ),
        }),
      };
      return dataOrThrow(api.POST("/api/integrations/metrics", { body }));
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      toast.success(
        `${identity.label} ${status.configured ? "updated" : "connected"}`,
      );
      await queryClient.invalidateQueries({
        queryKey: metricsSourceQuery().queryKey,
      });
      onDone?.();
    },
    onError: (err) => setError(connectMessage(err)),
  });

  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="Query" lead={QUERY_LEAD}>
        <SettingsRow
          id="metrics-query-url"
          title="Query URL"
          {...(content.queryHelp !== "" && { description: content.queryHelp })}
        >
          <Input
            aria-labelledby={rowLabel("metrics-query-url")}
            measure="beside"
            placeholder={content.queryPlaceholder}
            value={queryUrl}
            onChange={(e) => setQueryUrl(e.currentTarget.value)}
          />
        </SettingsRow>
        {authRow(
          "metrics-query-auth",
          content.auth,
          content.authHelp,
          queryCredential.method,
          (method) => setQueryCredential({ ...queryCredential, method }),
        )}
        {credentialRows("metrics-query", queryCredential, setQueryCredential)}
        {content.tenant && (
          <SettingsRow
            id="metrics-tenant"
            title="Tenant"
            description="The tenant to query, sent as X-Scope-OrgID."
          >
            <Input
              aria-labelledby={rowLabel("metrics-tenant")}
              measure="beside"
              value={orgId}
              onChange={(e) => setOrgId(e.currentTarget.value)}
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      <div className="flex flex-col gap-3">
        <SettingsGroup title="Recovery" lead={RULES_LEAD}>
          <SettingsRow
            id="metrics-rules-url"
            title="Rules URL"
            description={content.rulesHelp}
          >
            <Input
              aria-labelledby={rowLabel("metrics-rules-url")}
              measure="beside"
              placeholder={content.rulesPlaceholder}
              value={rulesUrl}
              onChange={(e) => setRulesUrl(e.currentTarget.value)}
            />
          </SettingsRow>
          {trim(rulesUrl) !== "" && (
            <SettingsRow
              id="metrics-rules-same"
              title="Use the same credentials"
              description="Off when the rules endpoint takes its own."
            >
              <Switch
                aria-labelledby={rowLabel("metrics-rules-same")}
                checked={sameCredential}
                onCheckedChange={setSameCredential}
              />
            </SettingsRow>
          )}
          {trim(rulesUrl) !== "" &&
            !sameCredential &&
            authRow(
              "metrics-rules-auth",
              content.auth,
              "",
              rulesCredential.method,
              (method) => setRulesCredential({ ...rulesCredential, method }),
            )}
          {trim(rulesUrl) !== "" &&
            !sameCredential &&
            credentialRows(
              "metrics-rules",
              rulesCredential,
              setRulesCredential,
            )}
        </SettingsGroup>

        <IntegrationWarnings warnings={content.warnings} />

        <ConnectFooter
          error={error}
          label={status.configured ? "Update" : "Connect"}
          disabled={trim(queryUrl) === "" || connect.isPending}
          onConnect={() => connect.mutate()}
          {...(onDone !== undefined && { onCancel: onDone })}
        />
      </div>
    </div>
  );
}

function ConnectedSource({
  status,
  actions,
}: {
  status: MetricsSourceStatus;
  actions: React.ReactNode;
}): React.JSX.Element {
  const auth = (hasAuth: boolean | undefined): string =>
    hasAuth === true ? "Credential stored" : "None";
  return (
    <>
      <SettingsGroup title="Query" lead={QUERY_LEAD}>
        <ValueRow id="metrics-query-endpoint" title="Endpoint">
          {status.query?.url}
        </ValueRow>
        <ValueRow id="metrics-query-credential" title="Authentication">
          {auth(status.query?.hasAuth)}
        </ValueRow>
        {status.query?.hasOrgId === true && (
          <ValueRow id="metrics-query-tenant" title="Tenant">
            Stored
          </ValueRow>
        )}
      </SettingsGroup>

      <div className="flex flex-col gap-3">
        <SettingsGroup title="Recovery" lead={RULES_LEAD}>
          {status.rules === null ? (
            /* Said here rather than discovered at 3am: this is the difference
             between an investigation that can close itself and one that cannot. */
            <ValueRow id="metrics-rules-endpoint" title="Rules endpoint">
              <IconLine icon={TriangleAlert} className="text-warn">
                <span>
                  None, so this source reaches Resolved only when your alert
                  source sends a resolved notification.
                </span>
              </IconLine>
            </ValueRow>
          ) : (
            <ValueRow id="metrics-rules-endpoint" title="Rules endpoint">
              {status.rules.url}
            </ValueRow>
          )}
          {status.rules !== null && (
            <ValueRow id="metrics-rules-credential" title="Authentication">
              {auth(status.rules.hasAuth)}
            </ValueRow>
          )}
        </SettingsGroup>
        {actions}
      </div>
    </>
  );
}

export function MetricsSourcePage({
  kind,
}: {
  kind: MetricsSourceKind;
}): React.JSX.Element {
  const identity = INTEGRATION_CATALOG[kind];
  const canManage = useCan({ integration: ["manage"] });
  const [updating, setUpdating] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const { data: status } = useSuspenseQuery(metricsSourceQuery());

  // One source across every product, so a card is connected, free, or blocked
  // by whichever other product holds the slot.
  const connected = status.configured && status.kind === kind;
  const heldByAnother = status.configured && status.kind !== kind;

  const disconnect = useDisconnect({
    label: identity.label,
    queryKey: metricsSourceQuery().queryKey,
    request: () => dataOrThrow(api.DELETE("/api/integrations/metrics")),
  });
  const test = useTestConnection({
    label: identity.label,
    queryKey: metricsSourceQuery().queryKey,
    request: () => dataOrThrow(api.POST("/api/integrations/metrics/test")),
  });

  return (
    <IntegrationPage
      identity={identity}
      facts={metaFacts(identity)}
      state={credentialState(connected, status.rejection)}
      rejection={connected ? status.rejection : null}
    >
      {heldByAnother && (
        <Alert variant="warning">
          <AlertTitle>Another metrics source is connected</AlertTitle>
          <AlertDescription>
            NightWarden queries one metrics source. Disconnect {status.label}{" "}
            first to connect {identity.label} instead.
          </AlertDescription>
        </Alert>
      )}

      {connected && !updating && (
        <ConnectedSource
          status={status}
          actions={
            <CredentialActions
              testing={test.isPending}
              onTest={() => test.mutate()}
              onUpdate={() => setUpdating(true)}
              onDisconnect={() => setConfirmRemove(true)}
            />
          }
        />
      )}

      {!connected && !heldByAnother && !canManage && <AdminsConnect />}

      {((!connected && !heldByAnother && canManage) ||
        (connected && updating)) && (
        <ConnectForm
          kind={kind}
          status={connected ? status : UNCONNECTED}
          {...(updating && { onDone: () => setUpdating(false) })}
        />
      )}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Disconnect ${identity.label}?`}
        description="Investigations lose metric evidence from this source until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </IntegrationPage>
  );
}

// What the form starts from when this product holds nothing yet.
const UNCONNECTED: MetricsSourceStatus = {
  configured: false,
  kind: null,
  label: null,
  query: null,
  rules: null,
  rejection: null,
};
