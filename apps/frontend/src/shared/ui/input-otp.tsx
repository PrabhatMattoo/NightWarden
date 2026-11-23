import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";

import { cn } from "@/shared/lib/utils";

// One transparent input sits over the slots, so a paste and a password manager fill them all.
function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        "flex items-center has-disabled:dim-control",
        containerClassName,
      )}
      spellCheck={false}
      className={cn("outline-none disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

// The active slot takes the focus outline the input itself gives up.
function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & { index: number }) {
  const context = React.useContext(OTPInputContext);
  const { char, isActive } = context.slots[index] ?? {};
  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        "relative flex size-10 items-center justify-center rounded-control border-hairline border-edge-input bg-transparent type-input highlight-motion aria-invalid:border-fail data-[active=true]:outline data-[active=true]:outline-focus data-[active=true]:-outline-offset-1",
        className,
      )}
      {...props}
    >
      {char}
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot };
