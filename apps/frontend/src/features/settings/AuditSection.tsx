import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";

import { dayClock } from "@/shared/lib/time";
import { Button } from "@/shared/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/shared/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/shared/ui/item";
import { auditSentence } from "./auditSentence";
import { auditQuery } from "./queries";
import { SettingsGroup } from "./SettingsRow";

export function AuditSection(): React.JSX.Element {
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useSuspenseInfiniteQuery(auditQuery());
  const events = data.pages.flatMap((page) => page.events);

  if (events.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia>
            <ScrollText />
          </EmptyMedia>
          <EmptyTitle>Nothing recorded yet</EmptyTitle>
          <EmptyDescription>
            Every approval of a write, and every change to people and teams, is
            listed here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup>
        {events.map((event) => (
          <Item key={event.id}>
            <ItemContent>
              <ItemTitle>{auditSentence(event)}</ItemTitle>
              <ItemDescription>{event.actorName}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <time
                dateTime={event.at}
                className="type-body whitespace-nowrap tabular-nums text-ink-muted"
              >
                {dayClock(event.at)}
              </time>
            </ItemActions>
          </Item>
        ))}
      </SettingsGroup>
      {hasNextPage && (
        <Button
          variant="quiet"
          size="sm"
          className="self-start"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
