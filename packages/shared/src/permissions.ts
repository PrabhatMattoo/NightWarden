import { createAccessControl } from "better-auth/plugins/access";
import type { RoleName } from "./roles.js";

const STATEMENTS = {
  session: ["read", "run", "approve", "delete"],
  integration: ["read", "manage"],
  runner: ["read", "manage"],
  settings: ["read", "manage"],
  mail: ["read", "manage"],
  audit: ["read"],
  organization: ["update"],
  member: ["read", "manage"],
  invitation: ["manage"],
  team: ["manage"],
} as const;

type Statements = typeof STATEMENTS;

export type Permission = {
  [Resource in keyof Statements]?: Statements[Resource][number][];
};

export const accessControl = createAccessControl(STATEMENTS);

export const ROLES: Record<
  RoleName,
  ReturnType<typeof accessControl.newRole>
> = {
  admin: accessControl.newRole(STATEMENTS),
  member: accessControl.newRole({
    session: ["read", "run", "approve"],
    integration: ["read"],
    runner: ["read"],
  }),
  viewer: accessControl.newRole({ session: ["read"] }),
};

export function isAllowed(
  role: RoleName | null,
  permission: Permission,
): boolean {
  return role !== null && ROLES[role].authorize(permission).success;
}
