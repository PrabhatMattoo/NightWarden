import { createAccessControl } from "better-auth/plugins/access";

const STATEMENTS = {
  session: ["read", "run", "approve", "delete"],
  integration: ["read", "manage"],
  runner: ["read", "manage"],
  settings: ["read", "manage"],
  mail: ["read", "manage"],
} as const;

type Statements = typeof STATEMENTS;

export type Permission = {
  [Resource in keyof Statements]?: Statements[Resource][number][];
};

const accessControl = createAccessControl(STATEMENTS);

export const ADMIN_ROLE = "admin";
// What a person added by an admin is, and what the admin plugin stamps by default.
export const MEMBER_ROLE = "member";

const ROLES = {
  [ADMIN_ROLE]: accessControl.newRole({
    session: ["read", "run", "approve", "delete"],
    integration: ["read", "manage"],
    runner: ["read", "manage"],
    settings: ["read", "manage"],
    mail: ["read", "manage"],
  }),
  [MEMBER_ROLE]: accessControl.newRole({
    session: ["read", "run", "approve"],
    integration: ["read"],
    runner: ["read"],
    settings: ["read"],
  }),
};

function isRoleName(name: string): name is keyof typeof ROLES {
  return Object.hasOwn(ROLES, name);
}

// The admin plugin stores several roles comma-separated, and any one may grant.
export function isAllowed(
  role: string | null | undefined,
  permission: Permission,
): boolean {
  return (role ?? "")
    .split(",")
    .some(
      (name) => isRoleName(name) && ROLES[name].authorize(permission).success,
    );
}
