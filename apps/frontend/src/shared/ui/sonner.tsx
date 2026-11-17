import * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

const TOAST_VARS: React.CSSProperties & Record<`--${string}`, string> = {
  "--normal-bg": "var(--control)",
  "--normal-text": "var(--ink-title)",
  "--normal-border": "var(--edge)",
  "--border-radius": "var(--radius-overlay)",
};

// Themed from the page's own roles, so it follows whichever theme is chosen.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      position="bottom-right"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={TOAST_VARS}
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
