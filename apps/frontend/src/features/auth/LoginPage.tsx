import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";

import { authCall, authClient } from "@/shared/api/authClient";
import { Button, buttonVariants } from "@/shared/ui/button";
import { FieldError } from "@/shared/ui/field";
import { AuthField, AuthFrame, FormHeading } from "@/features/auth/AuthForm";
import { CodeInput } from "@/features/auth/CodeInput";
import { useEnterApp } from "@/features/auth/useEnterApp";

// The password was right and the account has MFA: the same page asks for the second step.
function CodeStep({
  redirect,
  onBack,
}: {
  redirect: string | undefined;
  onBack: () => void;
}): React.JSX.Element {
  const enter = useEnterApp(redirect);
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const verify = useMutation({
    mutationFn: (value: string) =>
      authCall(
        recovery
          ? authClient.twoFactor.verifyBackupCode({ code: value })
          : authClient.twoFactor.verifyTotp({ code: value }),
      ),
    onSuccess: enter,
  });

  function switchMethod(): void {
    setRecovery(!recovery);
    setCode("");
    verify.reset();
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate(code.trim());
      }}
    >
      <div className="flex flex-col gap-2">
        <FormHeading>Multi-factor authentication</FormHeading>
        <p className="m-0 type-body text-ink-muted">
          {recovery
            ? "Enter one of your recovery codes. Each works once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
      </div>
      {recovery ? (
        <AuthField
          id="login-recovery-code"
          label="Recovery code"
          type="text"
          value={code}
          onChange={setCode}
        />
      ) : (
        <CodeInput
          value={code}
          invalid={verify.isError}
          disabled={verify.isPending}
          onChange={setCode}
          onComplete={(value) => verify.mutate(value)}
        />
      )}
      <div className="flex flex-col gap-2">
        {verify.error && <FieldError>{verify.error.message}</FieldError>}
        <Button
          type="submit"
          className="w-full"
          disabled={verify.isPending || code.trim() === ""}
        >
          Verify
        </Button>
        <Button type="button" variant="link" onClick={switchMethod}>
          {recovery
            ? "Use an authenticator code"
            : "Use a recovery code instead"}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

export function LoginPage(): React.JSX.Element {
  const { redirect } = useSearch({ from: "/login" });
  const enter = useEnterApp(redirect);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenged, setChallenged] = useState(false);
  const signIn = useMutation({
    mutationFn: () => authCall(authClient.signIn.email({ email, password })),
    onSuccess: (result) => {
      if (
        result !== null &&
        "twoFactorRedirect" in result &&
        result.twoFactorRedirect
      ) {
        setChallenged(true);
        return undefined;
      }
      return enter();
    },
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    signIn.mutate();
  }

  if (challenged) {
    return (
      <AuthFrame>
        <CodeStep
          redirect={redirect}
          onBack={() => {
            setChallenged(false);
            setPassword("");
            signIn.reset();
          }}
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <FormHeading>Log in</FormHeading>
        <AuthField
          id="login-email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
        />
        <AuthField
          id="login-password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
        />
        <Link
          to="/forgot-password"
          className={buttonVariants({ variant: "link" })}
        >
          Forgot password?
        </Link>
        <div className="flex flex-col gap-2">
          {signIn.error && <FieldError>{signIn.error.message}</FieldError>}
          <Button type="submit" className="w-full" disabled={signIn.isPending}>
            Log in
          </Button>
        </div>
      </form>
    </AuthFrame>
  );
}
