import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { PasswordInput } from "@/shared/ui/PasswordInput";

export function AuthFrame({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-svh items-start justify-center p-6 pt-24 animate-in fade-in duration-(--duration-content-in) lg:pt-40">
      <div className="flex w-login flex-col gap-8">
        <span className="type-heading text-ink-base">NightWarden</span>
        {children}
      </div>
    </div>
  );
}

// A legend leaves the fieldset's flow, so a flex gap never applies and the
// first field sits closer than every other.
export function FormHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return <h1 className="m-0 type-title text-ink-base">{children}</h1>;
}

// Revealed rather than reserved for, so no empty live region sits in the
// accessibility tree waiting to say nothing.
export function AuthField({
  id,
  label,
  type,
  value,
  description,
  error,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  type: "email" | "password" | "text";
  value: string;
  description?: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
}): React.JSX.Element {
  const invalid = Boolean(error);
  const control = {
    id,
    required: true,
    value,
    "aria-invalid": invalid,
    "aria-describedby": invalid ? `${id}-error` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange(e.currentTarget.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement>) =>
      onBlur?.(e.currentTarget.value),
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {type === "password" ? (
        <PasswordInput {...control} />
      ) : (
        <Input type={type} {...control} />
      )}
      {description !== undefined && (
        <FieldDescription>{description}</FieldDescription>
      )}
      {invalid && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}
