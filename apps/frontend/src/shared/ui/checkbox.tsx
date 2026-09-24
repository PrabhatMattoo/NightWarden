import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { cn } from "@/shared/lib/utils";
import { CHOICE_OPTION } from "@/shared/ui/choice";
import { CheckIcon } from "lucide-react";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-control border-hairline border-edge-strong highlight-motion hit-area aria-invalid:border-fail data-checked:border-accent data-checked:bg-accent data-checked:text-on-accent",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/* The checkbox counterpart of RadioGroupOption: children are the affordance,
   so a row that already marks itself does not also carry a tick. */
function CheckboxOption({
  className,
  children,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox-option"
      className={cn(CHOICE_OPTION, className)}
      {...props}
    >
      {children}
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox, CheckboxOption };
