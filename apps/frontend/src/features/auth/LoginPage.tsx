import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { authCall, authClient } from "@/shared/api/authClient";
import { Button } from "@/shared/ui/button";
import { FieldError } from "@/shared/ui/field";
import { AuthField, AuthFrame, FormHeading } from "@/features/auth/AuthForm";
import { useEnterApp } from "@/features/auth/useEnterApp";

export function LoginPage(): React.JSX.Element {
  const enter = useEnterApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: () => authCall(authClient.signIn.email({ email, password })),
    onSuccess: enter,
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    signIn.mutate();
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
