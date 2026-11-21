// Whole minutes, so the span never claims longer than the wait lasted.
function span(waitedMs: number): string {
  const minutes = Math.floor(waitedMs / 60_000);
  const counted = (n: number, unit: string): string =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return counted(minutes, "minute");
  return `${counted(Math.floor(minutes / 60), "hour")} and ${counted(minutes % 60, "minute")}`;
}

function listed(ids: readonly string[]): string {
  const head = ids.slice(0, -1);
  return head.length === 0
    ? ids.join(", ")
    : `${head.join(", ")} and ${ids.at(-1)}`;
}

/* Names the results read before a person's decision, since the system may have
   changed while the call waited and those results describe it as it was. */
export function decisionWaitMessage(
  toolName: string,
  waitedMs: number,
  evidenceIds: readonly string[],
): string {
  const waited = span(waitedMs);
  const ids = listed(evidenceIds);
  const one = evidenceIds.length === 1;
  const results = `${one ? "result" : "results"} ${ids}`;
  return `The ${toolName} call in your last reply waited ${waited} for a person's decision. ${one ? "Result" : "Results"} ${ids} ${one ? "was" : "were"} read before that wait began, so ${results} ${one ? "shows" : "show"} the system as it was at least ${waited} ago. Read the system again before you rely on ${results}.`;
}
