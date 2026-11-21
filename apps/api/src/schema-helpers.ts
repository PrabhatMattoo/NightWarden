import { sql } from "drizzle-orm";

// Only ever given our own constant arrays, so the values are never quoted input.
export function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}
