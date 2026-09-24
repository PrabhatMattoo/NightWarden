import { cn } from "@/shared/lib/utils";

// Clockwise from the top-left corner; the centre dot is the post the round circles.
const PERIMETER = [
  [3, 3],
  [8, 3],
  [13, 3],
  [13, 8],
  [13, 13],
  [8, 13],
  [3, 13],
  [3, 8],
] as const;

// Each dot's opacity at the loop's first instant, and the frame held when motion is reduced.
const REST = [1, 0.3, 0.3, 0.3, 0.3, 0.3, 0.575, 0.85] as const;

/* A lit dot walking the grid's edge. At page size it is a page's wait and names
   itself; beside a sentence it marks a live wait the sentence already names. */
export function Rounds({
  size = "page",
}: {
  size?: "page" | "inline";
}): React.JSX.Element {
  const page = size === "page";
  return (
    <svg
      data-slot="rounds"
      viewBox="0 0 16 16"
      role={page ? "status" : undefined}
      aria-label={page ? "Loading" : undefined}
      aria-hidden={page ? undefined : true}
      className={cn(
        "rounds shrink-0 fill-current text-ink-title",
        page ? "size-8" : "size-4 self-center",
      )}
    >
      <circle cx={8} cy={8} r={1.25} opacity={0.3} />
      {PERIMETER.map(([cx, cy], step) => (
        <circle
          key={step}
          data-step={step}
          cx={cx}
          cy={cy}
          r={1.25}
          opacity={REST[step]}
        />
      ))}
    </svg>
  );
}

// A live wait: the sentence names it, the grid says it is still going.
export function Waiting({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p
      className={cn(
        "flex items-center gap-2 type-body text-ink-muted",
        className,
      )}
    >
      <Rounds size="inline" />
      {children}
    </p>
  );
}
