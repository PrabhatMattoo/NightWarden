import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@/shared/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 border-edge data-horizontal:w-full data-horizontal:border-t-hairline data-vertical:self-stretch data-vertical:border-l-hairline",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
