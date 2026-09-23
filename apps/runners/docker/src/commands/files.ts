import { fitList, type HostFileResult } from "@nightwarden/shared";
import type { HostFileInput } from "@nightwarden/shared/schemas";
import { redactSecrets } from "@nightwarden/runner-core";
import { openAllowedFile } from "../safety/paths.js";

export async function readFileCommand(
  input: HostFileInput,
): Promise<HostFileResult> {
  // Open-then-validate closes the check/open symlink race; reads come from the
  // pinned handle, never re-resolving input.path.
  const handle = await openAllowedFile(input.path);
  let raw: string;
  try {
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  const allLines = raw.split("\n");
  const { items: kept, coverage } = fitList(allLines, {
    keep: "start",
    max: input.maxLines ?? 500,
    kept: "first",
    noun: "lines",
    reach: "Raise maxLines to read further into the file.",
  });
  const { content, redactedCount } = redactSecrets(kept.join("\n"));

  return {
    content,
    lineCount: kept.length,
    path: input.path,
    redactedLineCount: redactedCount,
    ...(coverage && { coverage }),
  };
}
