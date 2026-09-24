import { Card } from "@/shared/ui/card";
import { FieldLabel, FieldTitle } from "@/shared/ui/field";
import { Section } from "@/shared/ui/Page";
import { cn } from "@/shared/lib/utils";

interface SettingsRowProps {
  controlId: string;
  title: string;
  description?: string;
  // For a control too tall to sit beside its label, the allowlist being the
  // only one: it drops below and takes the full width.
  stacked?: boolean;
  // Drops the rule below, for a row the next one belongs to.
  joined?: boolean;
  /* `label for` may only name a form control, so a row holding a fact, a list
     or a disclosure titles itself and the content points at its id. */
  titleOnly?: boolean;
  // Waiting on an earlier choice: label and control fade as one, the divider stays.
  unavailable?: boolean;
  children: React.ReactNode;
}

export function SettingsRow({
  controlId,
  title,
  description,
  stacked = false,
  joined = false,
  titleOnly = false,
  unavailable = false,
  children,
}: SettingsRowProps): React.JSX.Element {
  return (
    <div
      data-unavailable={unavailable || undefined}
      className={cn(
        "relative flex p-4 data-unavailable:*:dim-row",
        !joined &&
          "not-last:after:absolute not-last:after:inset-x-4 not-last:after:bottom-0 not-last:after:border-b-hairline not-last:after:border-edge",
        stacked ? "flex-col gap-2" : "items-center justify-between gap-6",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {titleOnly ? (
          <FieldTitle id={`${controlId}-label`}>{title}</FieldTitle>
        ) : (
          <FieldLabel htmlFor={controlId}>{title}</FieldLabel>
        )}
        {description !== undefined && (
          <p className="type-small">{description}</p>
        )}
      </div>
      <div className={cn(stacked ? "w-full" : "shrink-0")}>{children}</div>
    </div>
  );
}

export function SettingsGroup({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Section {...(title !== undefined && { title })}>
      <Card>{children}</Card>
    </Section>
  );
}
