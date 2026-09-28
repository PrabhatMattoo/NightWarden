import { CodeBlock } from "@/shared/ui/code-block";
import { CopyButton } from "@/shared/ui/copy";
import { cn } from "@/shared/lib/utils";

// A block of several lines, such as a script, with its copy button in the corner.
export function CopyableSnippet({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("relative", className)}>
      <CodeBlock className="max-h-60 border-hairline border-edge-input bg-transparent p-3 pr-12">
        {text}
      </CodeBlock>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton text={text} label={label} />
      </div>
    </div>
  );
}
