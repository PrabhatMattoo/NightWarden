import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/shared/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // The accent only when on: an off switch is not a coloured thing.
        "peer group/switch relative inline-flex h-5 w-7.5 shrink-0 items-center rounded-full bg-switch-off transition-colors duration-(--duration-highlight-out) ease-out hit-area hover:bg-switch-off-hover disabled:pointer-events-none data-checked:bg-accent data-checked:hover:bg-accent-hover",
        className,
      )}
      {...props}
    >
      {/* Pointing at it stretches the knob 2px toward where it would go. */}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none absolute top-1/2 right-3.25 left-0.75 h-3.5 -translate-y-1/2 rounded-full bg-on-accent knob-stretch group-hover/switch:not-data-checked:right-2.75 data-checked:right-0.75 data-checked:left-3.25 group-hover/switch:data-checked:left-2.75"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
