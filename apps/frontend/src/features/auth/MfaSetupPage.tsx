import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";

import { authCall, authClient } from "@/shared/api/authClient";
import { api, dataOrThrow } from "@/shared/api/client";
import { toast } from "@/shared/lib/toast";
import { Button, buttonVariants } from "@/shared/ui/button";
import { InlineCopy } from "@/shared/ui/copy";
import { FieldError } from "@/shared/ui/field";
import { QrCode } from "@/shared/ui/QrCode";
import { AuthField, AuthFrame, FormHeading } from "@/features/auth/AuthForm";
import { CodeInput, MFA_CODE_LENGTH } from "@/features/auth/CodeInput";
import { mfaRequiredOf } from "@/features/auth/mfa";
import { authSessionQuery, devicesQuery } from "@/features/auth/queries";
import { RecoveryCodes } from "@/features/auth/RecoveryCodes";
import { useSignOut } from "@/features/auth/useSignOut";
import { organizationQuery } from "@/features/settings/queries";

interface Enrolment {
  totpUri: string;
  recoveryCodes: string[];
}

function StepTitle({
  step,
  children,
}: {
  step: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h2 className="m-0 type-item text-ink-title">
      {step}. {children}
    </h2>
  );
}

// The key an authenticator takes when the camera cannot read the code.
function keyOf(totpUri: string): string {
  return new URL(totpUri).searchParams.get("secret") ?? "";
}

/* One page for both ways in: a person turning MFA on from Settings, and one the
   organization has asked to. The second has no way past it but a sign-out. */
export function MfaSetupPage(): React.JSX.Element {
  const { data: session } = useSuspenseQuery(authSessionQuery());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useSignOut();
  // Read once: finishing setup lifts the requirement, which must not change the page under the person.
  const [required] = useState(() => mfaRequiredOf(session));
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [verified, setVerified] = useState(false);

  const enable = useMutation({
    mutationFn: async (): Promise<Enrolment> => {
      const started = await authCall(authClient.twoFactor.enable({ password }));
      if (started === null || !("totpURI" in started)) {
        throw new Error("MFA setup did not start.");
      }
      return { totpUri: started.totpURI, recoveryCodes: started.backupCodes };
    },
    onSuccess: (started) => {
      setPassword("");
      setEnrolment(started);
    },
  });

  const verify = useMutation({
    mutationFn: (value: string) =>
      authCall(authClient.twoFactor.verifyTotp({ code: value })),
    onSuccess: async () => {
      // Turning MFA on replaces the session, so the device list goes stale with it.
      await Promise.all([
        queryClient.query({ ...authSessionQuery(), staleTime: 0 }),
        queryClient.invalidateQueries({ queryKey: devicesQuery().queryKey }),
      ]);
      setVerified(true);
    },
  });

  const { after } = useSearch({ strict: false });
  // An admin who asked to require MFA set up their own first; finishing turns it on.
  const requireForEveryone = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.PATCH("/api/organization", { body: { requireMfa: true } }),
      ),
    onSuccess: (saved) =>
      queryClient.setQueryData(organizationQuery().queryKey, saved),
    onError: (err) =>
      toast.show({
        title: "MFA is not required yet",
        message: err.message,
        variant: "error",
      }),
  });

  async function finish(): Promise<void> {
    if (after === "require-mfa") {
      await requireForEveryone.mutateAsync().catch(() => undefined);
      await navigate({
        to: "/settings/$section",
        params: { section: "general" },
      });
      return;
    }
    await (required
      ? navigate({ to: "/" })
      : navigate({
          to: "/settings/$section",
          params: { section: "security" },
        }));
  }

  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        <FormHeading>Set up multi-factor authentication</FormHeading>

        {enrolment === null && (
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              enable.mutate();
            }}
          >
            <p className="m-0 type-body text-ink-muted">
              {required
                ? "Your organization requires MFA. Set it up to continue."
                : "Sign-in will ask for a code from an authenticator app, as well as your password."}
            </p>
            <StepTitle step={1}>Confirm your password</StepTitle>
            <AuthField
              id="mfa-password"
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
            />
            <div className="flex flex-col gap-2">
              {enable.error && <FieldError>{enable.error.message}</FieldError>}
              <Button
                type="submit"
                className="w-full"
                disabled={enable.isPending || password === ""}
              >
                Continue
              </Button>
            </div>
          </form>
        )}

        {enrolment !== null && !verified && (
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate(code);
            }}
          >
            <div className="flex flex-col gap-3">
              <StepTitle step={2}>Add it to your authenticator app</StepTitle>
              <p className="m-0 type-body text-ink-muted">
                Scan the code with an authenticator app, or type the key in.
              </p>
              <div className="flex justify-center">
                <QrCode
                  value={enrolment.totpUri}
                  label="QR code for your authenticator app"
                />
              </div>
              <InlineCopy
                text={keyOf(enrolment.totpUri)}
                label="Copy the setup key"
              />
            </div>
            <div className="flex flex-col gap-3">
              <StepTitle step={3}>Enter the code it shows</StepTitle>
              <CodeInput
                value={code}
                invalid={verify.isError}
                disabled={verify.isPending}
                onChange={setCode}
                onComplete={(value) => verify.mutate(value)}
              />
              {verify.error && <FieldError>{verify.error.message}</FieldError>}
              <Button
                type="submit"
                className="w-full"
                disabled={verify.isPending || code.length < MFA_CODE_LENGTH}
              >
                Verify and turn on
              </Button>
            </div>
          </form>
        )}

        {enrolment !== null && verified && (
          <div className="flex flex-col gap-3">
            <StepTitle step={4}>Keep your recovery codes</StepTitle>
            <p className="m-0 type-body text-ink-muted">
              MFA is on. If you lose your authenticator, each of these signs you
              in once. They are not shown again.
            </p>
            <RecoveryCodes codes={enrolment.recoveryCodes} />
            <Button
              type="button"
              className="w-full"
              onClick={() => void finish()}
            >
              I have saved them
            </Button>
          </div>
        )}

        {!verified &&
          (required ? (
            <Button
              type="button"
              variant="ghost"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              Sign out
            </Button>
          ) : (
            <Link
              to="/settings/$section"
              params={{ section: "security" }}
              className={buttonVariants({ variant: "ghost" })}
            >
              Back to settings
            </Link>
          ))}
      </div>
    </AuthFrame>
  );
}
