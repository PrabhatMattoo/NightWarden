import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { useCan } from "@/features/auth/useCan";

/* A role without approval reads the card but cannot answer it. The button stays in sight
   and says why; aria-disabled, unlike disabled, keeps it focusable so the tooltip is reachable. */
export function DecisionButton({
  onClick,
  disabled,
  ...props
}: React.ComponentProps<typeof Button>): React.JSX.Element {
  const canApprove = useCan({ session: ["approve"] });
  if (canApprove) {
    return <Button onClick={onClick} disabled={disabled} {...props} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<Button aria-disabled="true" {...props} />} />
      <TooltipContent>Your role can&apos;t answer this card.</TooltipContent>
    </Tooltip>
  );
}
