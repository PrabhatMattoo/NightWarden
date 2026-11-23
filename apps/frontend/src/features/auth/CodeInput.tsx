import { REGEXP_ONLY_DIGITS } from "input-otp";

import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/shared/ui/input-otp";

export const MFA_CODE_LENGTH = 6;

// The code an authenticator app shows, sent the moment the last digit lands.
export function CodeInput({
  value,
  invalid,
  disabled,
  onChange,
  onComplete,
}: {
  value: string;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onComplete: (value: string) => void;
}): React.JSX.Element {
  return (
    <InputOTP
      autoFocus
      aria-label="Authentication code"
      autoComplete="one-time-code"
      inputMode="numeric"
      maxLength={MFA_CODE_LENGTH}
      pattern={REGEXP_ONLY_DIGITS}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      disabled={disabled}
    >
      <InputOTPGroup>
        {Array.from({ length: MFA_CODE_LENGTH }, (_, index) => (
          <InputOTPSlot
            key={index}
            index={index}
            aria-invalid={invalid || undefined}
          />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}
