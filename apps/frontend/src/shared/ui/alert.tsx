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
  "group/alert relative grid w-full grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-left text-sm text-foreground *:[svg]:row-span-2 *:[svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        destructive: "bg-destructive-tint *:[svg]:text-destructive",
        warning: "bg-warning-tint *:[svg]:text-warning",
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
      {children}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 font-medium [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className,
      )}
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
        "col-start-2 text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
