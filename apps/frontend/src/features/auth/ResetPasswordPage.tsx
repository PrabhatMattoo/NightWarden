import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { PASSWORD_MIN_LENGTH } from "@nightwarden/shared";

import { authCall, authClient } from "@/shared/api/authClient";
import { toast } from "@/shared/lib/toast";
import { Button, buttonVariants } from "@/shared/ui/button";
import { FieldError } from "@/shared/ui/field";
import { AuthField, AuthFrame, FormHeading } from "@/features/auth/AuthForm";

function RequestNewLink(): React.JSX.Element {
  return (
    <Link to="/forgot-password" className={buttonVariants({ variant: "link" })}>
      Request a new link
    </Link>
  );
}

export function ResetPasswordPage(): React.JSX.Element {
  const { token, error } = useSearch({ from: "/reset-password" });
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: (link: string) =>
      authCall(
        authClient.resetPassword({ newPassword: password, token: link }),
      ),
    onSuccess: async () => {
      toast.success("Password changed. Log in with the new one.");
      await navigate({ to: "/login" });
    },
  });

  if (token === undefined || error !== undefined) {
    return (
      <AuthFrame>
        <div className="flex flex-col gap-6">
          <FormHeading>This link does not work</FormHeading>
          <p className="m-0 type-body text-ink-muted">
            A reset link can be used once, and it expires.
          </p>
          <RequestNewLink />
        </div>
      </AuthFrame>
    );
  }

  const tooShort = password.length < PASSWORD_MIN_LENGTH;

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (token !== undefined && !tooShort) reset.mutate(token);
  }

  return (
    <AuthFrame>
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <FormHeading>Choose a new password</FormHeading>
        <AuthField
          id="reset-password"
          label="New password"
          type="password"
          value={password}
          description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          onChange={setPassword}
        />
        <div className="flex flex-col gap-2">
          {reset.error && (
            <>
              <FieldError>{reset.error.message}</FieldError>
              <RequestNewLink />
            </>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={reset.isPending || tooShort}
          >
            Change password
          </Button>
        </div>
      </form>
    </AuthFrame>
  );
}
