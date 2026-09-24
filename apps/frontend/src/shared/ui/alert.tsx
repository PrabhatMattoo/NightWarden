import * as React from "react";
import { cva } from "class-variance-authority";
import { CircleAlert, TriangleAlert } from "lucide-react";

import { ICON_UI } from "@/shared/lib/iconProps";
import { cn } from "@/shared/lib/utils";

/* No neutral rung. An alert that carries no tone is a paragraph, and one drawn
   as a box anyway is a box the eye stops at for nothing. */
type AlertVariant = "destructive" | "warning";

/* One accent, not a flood: the icon carries the tone, the title and body stay
   neutral. A whole block in the status colour reads as louder than it is. */
const alertVariants = cva(
  "group/alert relative flex w-full gap-2 rounded-card border-hairline border-edge px-3 py-2.5 text-left type-body *:[svg]:mt-0.5 *:[svg]:shrink-0",
  {
    variants: {
      variant: {
        destructive: "bg-fail-tint *:[svg]:text-fail",
        warning: "bg-warn-tint *:[svg]:text-warn",
      },
    },
  },
);

// The icon says what the variant says, so passing it in is one more way for a
// box to end up looking unlike the box beside it.
const ICON: Record<AlertVariant, typeof TriangleAlert> = {
  destructive: CircleAlert,
  warning: TriangleAlert,
};

function Alert({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<"div"> & { variant: AlertVariant }) {
  const Icon = ICON[variant];
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <Icon {...ICON_UI} />
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("type-item", className)}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "type-body text-pretty text-ink-base [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
