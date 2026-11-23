import { Download } from "lucide-react";

import { ICON_UI } from "@/shared/lib/iconProps";
import { Button } from "@/shared/ui/button";
import { CopyButton } from "@/shared/ui/copy";

// A file in the person's own hands is the other way to keep them, beside a password manager.
function download(codes: readonly string[]): void {
  const url = URL.createObjectURL(
    new Blob([`${codes.join("\n")}\n`], { type: "text/plain" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "nightwarden-recovery-codes.txt";
  link.click();
  // Revoked after the click has been handled, since some browsers cancel a download whose link is gone.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Shown once: the server keeps them only to check one against what is typed.
export function RecoveryCodes({
  codes,
}: {
  codes: readonly string[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-1 rounded-control border-hairline border-edge-input p-3 font-mono type-body text-ink-title">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <CopyButton text={codes.join("\n")} label="Copy recovery codes" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => download(codes)}
        >
          <Download {...ICON_UI} />
          Download
        </Button>
      </div>
    </div>
  );
}
