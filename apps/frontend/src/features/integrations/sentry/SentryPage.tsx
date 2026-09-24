import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { SentryIntegrationStatus } from "@nightwarden/shared";

import { Alert, AlertTitle, AlertDescription } from "@/shared/ui/alert";
import { StatusText } from "@/shared/ui/status";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/shared/ui/field";
import { Page } from "@/shared/ui/Page";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { ConnectedState, type Fact } from "@/features/integrations/FactGrid";
import { toast } from "@/shared/lib/toast";
import { dayClock } from "@/shared/lib/time";
import { apiFetch } from "@/shared/api/client";
import { connectMessage, useDisconnect } from "../useIntegration";
import { INTEGRATION_CATALOG } from "../catalog";
import { sentryStatusQuery } from "../queries";
import { IntegrationHeader } from "@/features/integrations/IntegrationHeader";

export function SentryPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [token, setToken] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const { data: status } = useSuspenseQuery(sentryStatusQuery());

  const connect = useMutation({
    mutationFn: () =>
      apiFetch<SentryIntegrationStatus>("/api/integrations/sentry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          orgSlug: orgSlug.trim(),
          token: token.trim(),
        }),
      }),
    onMutate: () => setConnectError(null),
    onSuccess: async () => {
      setUrl("");
      setOrgSlug("");
      setToken("");
      toast.success("Sentry connected");
      await queryClient.invalidateQueries({
        queryKey: sentryStatusQuery().queryKey,
      });
    },
    onError: (err) => setConnectError(connectMessage(err)),
  });

  const disconnect = useDisconnect({
    label: "Sentry",
    queryKey: sentryStatusQuery().queryKey,
    endpoint: () => "/api/integrations/sentry",
  });

  const facts: Fact[] = status.configured
    ? [
        {
          label: "Status",
          value: <StatusText tone="ok">Connected</StatusText>,
        },
        { label: "Base URL", value: status.url },
        ...(status.orgSlug !== null
          ? [{ label: "Organization", value: status.orgSlug } satisfies Fact]
          : []),
        ...(status.validatedAt !== null
          ? [
              {
                label: "Last verified",
                value: dayClock(status.validatedAt),
              } satisfies Fact,
            ]
          : []),
      ]
    : [];

  return (
    <Page
      back={{ to: "/integrations", label: "Integrations" }}
      measure="narrow"
    >
      <div className="flex flex-col gap-8">
        <IntegrationHeader identity={INTEGRATION_CATALOG.sentry} />

        {!status.configured && (
          <section className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="sentry-url">Sentry URL</FieldLabel>
              <FieldDescription>
                The base address, without the /api/0 path. sentry.io or
                self-hosted.
              </FieldDescription>
              <Input
                id="sentry-url"
                measure="field"
                placeholder="https://sentry.example.com"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sentry-org">Organization slug</FieldLabel>
              <FieldDescription>
                The organization in the URL when you browse Sentry, not its
                display name.
              </FieldDescription>
              <Input
                id="sentry-org"
                measure="short"
                placeholder="acme"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sentry-token">Auth token</FieldLabel>
              <FieldDescription>
                An internal integration token with both event:read and
                project:read.
              </FieldDescription>
              <Input
                id="sentry-token"
                type="password"
                measure="field"
                placeholder="sntrys_..."
                value={token}
                onChange={(e) => setToken(e.currentTarget.value)}
              />
            </Field>

            {connectError !== null && (
              <Alert variant="destructive">
                <AlertTitle>Could not connect</AlertTitle>
                <AlertDescription>{connectError}</AlertDescription>
              </Alert>
            )}

            <Button
              className="self-start"
              disabled={
                url.trim() === "" ||
                orgSlug.trim() === "" ||
                token.trim() === "" ||
                connect.isPending
              }
              onClick={() => connect.mutate()}
            >
              Connect
            </Button>
          </section>
        )}

        {status.configured && (
          <ConnectedState
            facts={facts}
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </Button>
            }
          />
        )}
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Sentry?"
        description="Investigations lose exception and release evidence until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </Page>
  );
}
