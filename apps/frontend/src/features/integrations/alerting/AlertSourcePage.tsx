import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import type { AlertSourceKind } from "@nightwarden/shared";

import { Button } from "@/shared/ui/button";
import { FieldDescription } from "@/shared/ui/field";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { InlineCopy } from "@/shared/ui/copy";
import { SettingsGroup, SettingsRow } from "@/features/settings/SettingsRow";
import { IntegrationWarnings } from "../IntegrationWarnings";
import {
  ConnectionActions,
  IntegrationPage,
  metaFacts,
  NOT_CONNECTED,
} from "../IntegrationPage";
import { timeAgo } from "@/shared/lib/time";
import { toast } from "@/shared/lib/toast";
import { api, dataOrThrow } from "@/shared/api/client";
import { useDisconnect } from "../useIntegration";
import { ALERT_SOURCE_CONTENT } from "./content";
import { INTEGRATION_CATALOG } from "../catalog";
import { alertSourceQuery } from "../queries";

export function AlertSourcePage({
  kind,
}: {
  kind: AlertSourceKind;
}): React.JSX.Element {
  const content = ALERT_SOURCE_CONTENT[kind];
  const identity = INTEGRATION_CATALOG[kind];
  const queryClient = useQueryClient();
  // Set only by a mint, cleared only by the user saying they have copied it.
  // Nothing can put it back: the API keeps no readable copy.
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const path = { params: { path: { kind } } };
  const { queryKey } = alertSourceQuery(kind);
  const { data: status } = useSuspenseQuery(alertSourceQuery(kind));

  const unsaved = secret !== null;
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    disabled: !unsaved,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  });

  const generate = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/integrations/alerting/{kind}/credential", path),
      ),
    onSuccess: async ({ token }) => {
      setSecret(token);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) =>
      toast.show({
        title: "Could not generate the secret",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const disconnect = useDisconnect({
    label: identity.label,
    queryKey,
    request: () =>
      dataOrThrow(api.DELETE("/api/integrations/alerting/{kind}", path)),
  });

  const configured = status.configured;
  const receiving = status.lastReceivedAt !== null;

  return (
    <IntegrationPage
      identity={identity}
      facts={metaFacts(
        identity,
        configured
          ? [
              {
                key: "last-alert",
                content: receiving
                  ? `Last alert ${timeAgo(status.lastReceivedAt)} ago`
                  : "No alert yet",
              },
            ]
          : [],
      )}
      state={
        !configured
          ? NOT_CONNECTED
          : receiving
            ? { tone: "ok", label: "Receiving" }
            : { tone: "muted", label: "Waiting for first alert" }
      }
    >
      <div className="flex flex-col gap-3">
        <SettingsGroup title="Webhook" lead={content.where}>
          <SettingsRow
            id="alert-webhook-url"
            title="Webhook URL"
            description="Where the sender delivers."
          >
            <InlineCopy label="Copy the webhook URL" text={status.ingestUrl} />
          </SettingsRow>
          <SettingsRow
            id="alert-secret"
            title="Secret"
            description="What proves a delivery came from your sender."
            stacked={secret !== null}
          >
            {secret !== null ? (
              <div className="flex flex-col gap-3">
                <InlineCopy label="Copy the secret" text={secret} />
                <FieldDescription>
                  Copy it now. It is not shown again and cannot be recovered; if
                  you lose it, rotate for a new one.
                </FieldDescription>
                <div className="flex justify-end">
                  <Button onClick={() => setSecret(null)}>
                    I&apos;ve saved it
                  </Button>
                </div>
              </div>
            ) : (
              // Stored hashed, so once saved there is nothing here to show or copy.
              <span className="type-body text-ink-muted">
                {configured ? "Not shown again" : "Not generated yet"}
              </span>
            )}
          </SettingsRow>
        </SettingsGroup>

        {/* A freshly minted secret is a step to finish, so it holds the actions back. */}
        {secret === null &&
          (configured ? (
            <ConnectionActions onDisconnect={() => setConfirmDisconnect(true)}>
              <Button
                variant="secondary"
                disabled={generate.isPending}
                onClick={() => setConfirmRotate(true)}
              >
                Rotate secret
              </Button>
            </ConnectionActions>
          ) : (
            <ConnectionActions>
              <Button
                disabled={generate.isPending}
                onClick={() => generate.mutate()}
              >
                Generate secret
              </Button>
            </ConnectionActions>
          ))}

        {/* Stated where they are set: these fail without reporting. */}
        <IntegrationWarnings warnings={content.warnings} />
      </div>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate the secret?"
        description={content.rotateDescription}
        confirmLabel="Rotate"
        destructive
        onConfirm={() => generate.mutate()}
      />

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${identity.label}?`}
        description="The secret stops working immediately and further deliveries are refused. Investigations already open are unaffected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />

      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.status === "blocked") blocker.reset();
        }}
        title="Leave without saving the secret?"
        description="It is not shown again. You would have to rotate to get a working one."
        confirmLabel="Leave"
        destructive
        onConfirm={() => {
          if (blocker.status === "blocked") blocker.proceed();
        }}
      />
    </IntegrationPage>
  );
}
