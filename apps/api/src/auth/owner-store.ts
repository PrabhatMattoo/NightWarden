import { getDb } from "../db.js";

// Whether the install has its owner yet: registration stays open only until it does.
export async function ownerExists(): Promise<boolean> {
  const row = await getDb().selectFrom("user").select("id").executeTakeFirst();
  return row !== undefined;
}
