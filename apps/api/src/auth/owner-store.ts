import { getDb } from "../db.js";
import { user } from "./schema.js";

// Whether the install has its owner yet: setup stays open only until it does.
export function ownerExists(): boolean {
  return getDb().select({ id: user.id }).from(user).get() !== undefined;
}
