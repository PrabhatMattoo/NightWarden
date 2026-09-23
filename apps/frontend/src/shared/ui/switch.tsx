import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/shared/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // The accent only when on: an off switch is not a coloured thing.
        "peer group/switch relative inline-flex h-5 w-7.5 shrink-0 items-center rounded-full bg-switch-off highlight-motion after:absolute after:-inset-x-3 after:-inset-y-2 disabled:opacity-50 data-checked:bg-accent",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 translate-x-0.75 rounded-full bg-on-accent transition-transform data-checked:translate-x-3.25"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
