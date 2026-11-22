import { useState } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { authCall, authClient } from "@/shared/api/authClient";
import { Button, buttonVariants } from "@/shared/ui/button";
import { FieldError } from "@/shared/ui/field";
import { AuthField, AuthFrame, FormHeading } from "@/features/auth/AuthForm";
import { signInOptionsQuery } from "@/features/auth/queries";

function BackToLogin(): React.JSX.Element {
  return (
    <Link to="/login" className={buttonVariants({ variant: "link" })}>
      Back to log in
    </Link>
  );
}

export function ForgotPasswordPage(): React.JSX.Element {
  const { data: options } = useSuspenseQuery(signInOptionsQuery());
  const [email, setEmail] = useState("");
  // Better Auth answers the same whether or not the account exists, and so does this page.
  const request = useMutation({
    mutationFn: () =>
      authCall(
        authClient.requestPasswordReset({
          email,
          redirectTo: "/reset-password",
        }),
      ),
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    request.mutate();
  }

  if (!options.passwordReset) {
    return (
      <AuthFrame>
        <div className="flex flex-col gap-6">
          <FormHeading>Forgot your password?</FormHeading>
          <p className="m-0 type-body text-ink-muted">
            This install has no mail server set up, so it cannot email a reset
            link. Ask an admin to reset your password.
          </p>
          <BackToLogin />
        </div>
      </AuthFrame>
    );
  }

  if (request.isSuccess) {
    return (
      <AuthFrame>
        <div className="flex flex-col gap-6">
          <FormHeading>Check your email</FormHeading>
          <p className="m-0 type-body text-ink-muted">
            If an account uses {email}, a link to choose a new password is on
            its way.
          </p>
          <BackToLogin />
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <FormHeading>Forgot your password?</FormHeading>
        <AuthField
          id="forgot-email"
          label="Email"
          type="email"
          value={email}
          description="We will email a link to choose a new password."
          onChange={setEmail}
        />
        <div className="flex flex-col gap-2">
          {request.error && <FieldError>{request.error.message}</FieldError>}
          <Button type="submit" className="w-full" disabled={request.isPending}>
            Send reset link
          </Button>
        </div>
        <BackToLogin />
      </form>
    </AuthFrame>
  );
}
