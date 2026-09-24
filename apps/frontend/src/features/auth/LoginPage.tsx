import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";

import { ICON_UI } from "@/shared/lib/iconProps";
import { authCall, authClient } from "@/shared/api/authClient";
import { Button } from "@/shared/ui/button";
import { Field, FieldError, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { authStatusQuery } from "@/features/auth/queries";

const MIN_PASSWORD = 12;

// Revealed rather than reserved for, so no empty live region sits in the
// accessibility tree waiting to say nothing.
function AuthField({
  id,
  label,
  type,
  value,
  error,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  type: "email" | "password" | "text";
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
}): React.JSX.Element {
  const invalid = Boolean(error);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        required
        value={value}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={(e) => onBlur?.(e.currentTarget.value)}
      />
      {invalid && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

// A legend leaves the fieldset's flow, so a flex gap never applies and the
// first field sits closer than every other.
function FormHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return <h1 className="m-0 type-title text-ink-base">{children}</h1>;
}

function ServerError({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="flex items-start gap-1 type-body text-fail" role="alert">
      <AlertCircle {...ICON_UI} className="mt-px shrink-0" />
      <span>{message}</span>
    </p>
  );
}

// Signed in: the status is read again so the app layout finds the session, then the app opens.
function useEnter(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await queryClient.query({ ...authStatusQuery(), staleTime: 0 });
    await navigate({ to: "/" });
  };
}

function SetupForm(): React.JSX.Element {
  const enter = useEnter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const signUp = useMutation({
    mutationFn: () =>
      authCall(authClient.signUp.email({ name, email, password })),
    onSuccess: enter,
  });

  function validatePassword(value: string): boolean {
    if (value === "") {
      setPasswordError("");
      return true;
    }
    const tooShort = value.length < MIN_PASSWORD;
    setPasswordError(
      tooShort ? `Password must be at least ${MIN_PASSWORD} characters` : "",
    );
    return !tooShort;
  }

  function validateConfirm(value: string, against: string): boolean {
    if (value === "") {
      setConfirmError("");
      return true;
    }
    const mismatched = value !== against;
    setConfirmError(mismatched ? "Passwords do not match" : "");
    return !mismatched;
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    signUp.reset();
    const passwordOk = validatePassword(password);
    const confirmOk = validateConfirm(confirmPassword, password);
    if (passwordOk && confirmOk) signUp.mutate();
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
      <FormHeading>Create your account</FormHeading>
      {/* Shown on an approval record, so it is a person's name and not a login. */}
      <AuthField
        id="setup-name"
        label="Your name"
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
      <AuthField
        id="setup-confirm"
        label="Confirm password"
        type="password"
        value={confirmPassword}
        error={confirmError}
        onChange={setConfirmPassword}
        onBlur={(v) => validateConfirm(v, password)}
      />
      <div className="flex flex-col gap-2">
        {signUp.error && <ServerError message={signUp.error.message} />}
        <Button type="submit" className="w-full" disabled={signUp.isPending}>
          Create account
        </Button>
      </div>
    </form>
  );
}

function LoginForm(): React.JSX.Element {
  const enter = useEnter();
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
        {signIn.error && <ServerError message={signIn.error.message} />}
        <Button type="submit" className="w-full" disabled={signIn.isPending}>
          Log in
        </Button>
      </div>
    </form>
  );
}

export function LoginPage(): React.JSX.Element {
  const { data: status } = useSuspenseQuery(authStatusQuery());
  return (
    <div className="flex min-h-svh items-start justify-center p-6 pt-24 animate-in fade-in duration-(--duration-content-in) lg:pt-40">
      <div className="flex w-login flex-col gap-8">
        <span className="type-heading text-ink-base">NightWarden</span>
        {status.ownerExists ? <LoginForm /> : <SetupForm />}
      </div>
    </div>
  );
}
