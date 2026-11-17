// A JSON string on the wire and an object on a live card, so one place asks
// and a malformed result is handled once.
export function asRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return isObject(parsed) ? parsed : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function numberAt(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringAt(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
