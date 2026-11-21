import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { PASSWORD_MIN_LENGTH } from "@nightwarden/shared";

import { api, dataOrThrow } from "@/shared/api/client";
import { Button } from "@/shared/ui/button";
import { FieldError } from "@/shared/ui/field";
import { AuthField, AuthFrame, FormHeading } from "@/features/auth/AuthForm";
import { setupQuery } from "@/features/auth/queries";
import { useEnterApp } from "@/features/auth/useEnterApp";

export function SetupPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const enter = useEnterApp();
  const hash = useRouterState({ select: (s) => s.location.hash });
  const linkToken =
    new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";
  const [typedToken, setTypedToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const setup = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/setup", {
          body: {
            token: linkToken === "" ? typedToken : linkToken,
            name,
            email,
            password,
          },
        }),
      ),
    onSuccess: async () => {
      queryClient.setQueryData(setupQuery().queryKey, { required: false });
      await enter();
    },
  });

  function validatePassword(value: string): boolean {
    if (value === "") {
      setPasswordError("");
      return true;
    }
    const tooShort = value.length < PASSWORD_MIN_LENGTH;
    setPasswordError(
      tooShort
        ? `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
        : "",
    );
    return !tooShort;
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setup.reset();
    if (validatePassword(password)) setup.mutate();
  }

  return (
    <AuthFrame>
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <FormHeading>Create your account</FormHeading>
        {linkToken === "" && (
          <AuthField
            id="setup-token"
            label="Setup token"
            type="text"
            value={typedToken}
            description="The server printed it in its log, and it is in the setup-token file in NightWarden's state directory."
            onChange={setTypedToken}
          />
        )}
        {/* Shown on an approval record, so it is a person's name and not a login. */}
        <AuthField
          id="setup-name"
          label="Name"
          type="text"
          value={name}
          onChange={setName}
        />
        <AuthField
          id="setup-email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
        />
        <AuthField
          id="setup-password"
          label="Password"
          type="password"
          value={password}
          error={passwordError}
          onChange={setPassword}
          onBlur={validatePassword}
        />
        <div className="flex flex-col gap-2">
          {setup.error && <FieldError>{setup.error.message}</FieldError>}
          <Button type="submit" className="w-full" disabled={setup.isPending}>
            Create account
          </Button>
        </div>
      </form>
    </AuthFrame>
  );
}
