/* Copying says only what happened: the check appears once the clipboard has the
   text, a refusal shows as one, and both are announced as well as drawn. */

import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Copy } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { ICON_UI } from "@/shared/lib/iconProps";

type CopyState = "idle" | "copied" | "failed";

const SAID: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Could not copy",
};

// The label names what lands on the clipboard, so two buttons on a page never read alike.
function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}): React.JSX.Element {
  const [state, setState] = useState<CopyState>("idle");
  const [hovered, setHovered] = useState(false);
  const revert = useRef<number>(undefined);

  useEffect(() => () => window.clearTimeout(revert.current), []);

  async function copy(): Promise<void> {
    let next: CopyState;
    try {
      await navigator.clipboard.writeText(text);
      next = "copied";
    } catch {
      next = "failed";
    }
    setState(next);
    window.clearTimeout(revert.current);
    revert.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <>
      <Tooltip open={hovered || state !== "idle"} onOpenChange={setHovered}>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              onClick={() => void copy()}
            />
          }
        >
          {state === "copied" ? (
            <Check {...ICON_UI} className="text-ok" />
          ) : state === "failed" ? (
            <CircleAlert {...ICON_UI} className="text-fail" />
          ) : (
            <Copy {...ICON_UI} />
          )}
        </TooltipTrigger>
        <TooltipContent>{SAID[state]}</TooltipContent>
      </Tooltip>
      <span role="status" className="sr-only">
        {state === "idle" ? "" : SAID[state]}
      </span>
    </>
  );
}

// A single value handed over whole: the text as it is, its copy button right after it.
function InlineCopy({
  text,
  label,
}: {
  text: string;
  label: string;
}): React.JSX.Element {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 font-mono type-body break-all text-ink-title">
        {text}
      </code>
      <CopyButton text={text} label={label} />
    </span>
  );
}

export { CopyButton, InlineCopy };
