export const AUDIT_ACTIONS = [
  "write_approved",
  "write_rejected",
  "organization_created",
  "organization_updated",
  "member_added",
  "member_invited",
  "invitation_canceled",
  "member_joined",
  "member_role_changed",
  "member_removed",
  "team_created",
  "team_renamed",
  "team_deleted",
  "team_member_added",
  "team_member_removed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
