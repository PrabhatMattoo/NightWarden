import { Children, Fragment, isValidElement } from "react";

import { Card } from "@/shared/ui/card";
import { FieldTitle } from "@/shared/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
} from "@/shared/ui/item";
import { Section } from "@/shared/ui/Page";

// The id a row's control names itself by, through aria-labelledby.
export const rowLabel = (id: string): string => `${id}-label`;

interface SettingsRowProps {
  id: string;
  title: string;
  description?: string;
  // For a control too tall to sit beside its title: it drops below at full width.
  stacked?: boolean;
  // No rule below, for a row the next one belongs to.
  joined?: boolean;
  // Waiting on an earlier choice: title and control fade as one, the divider stays.
  unavailable?: boolean;
  // The environment variable that sets this value; the control beside it is disabled.
  lockedBy?: string;
  children: React.ReactNode;
}

/* The title is never a <label for>: a hovered label hovers its control too, so
   the control names itself by the title's id instead. */
export function SettingsRow({
  id,
  title,
  description,
  stacked = false,
  unavailable = false,
  lockedBy,
  children,
}: SettingsRowProps): React.JSX.Element {
  return (
    <Item
      size="lg"
      layout={stacked ? "stacked" : "row"}
      data-unavailable={unavailable || undefined}
    >
      <ItemContent>
        <FieldTitle id={rowLabel(id)}>{title}</FieldTitle>
        {description !== undefined && (
          <ItemDescription>{description}</ItemDescription>
        )}
        {lockedBy !== undefined && (
          <ItemDescription>Set by environment ({lockedBy})</ItemDescription>
        )}
      </ItemContent>
      <ItemActions
        {...(stacked && { className: "ml-0 w-full flex-col items-stretch" })}
      >
        {children}
      </ItemActions>
    </Item>
  );
}

// A rule between rows, except after one that is joined to the row it introduces.
export function SettingsGroup({
  title,
  lead,
  action,
  children,
}: {
  title?: string;
  lead?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const rows = Children.toArray(children).filter(
    (child): child is React.ReactElement<{ joined?: boolean }> =>
      isValidElement(child),
  );
  return (
    <Section
      {...(title !== undefined && { title })}
      {...(lead !== undefined && { lead })}
      {...(action !== undefined && { action })}
    >
      <Card>
        <ItemGroup>
          {rows.map((row, i) => {
            const joined = rows[i - 1]?.props.joined === true;
            return (
              <Fragment key={row.key ?? i}>
                {i > 0 && !joined && <ItemSeparator />}
                {row}
              </Fragment>
            );
          })}
        </ItemGroup>
      </Card>
    </Section>
  );
}
