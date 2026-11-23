export const ADMIN_ROLE = "admin";
export const ROLE_NAMES = [ADMIN_ROLE, "member", "viewer"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
