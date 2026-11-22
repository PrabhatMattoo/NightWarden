export const AUDIT_ACTIONS = ["write_approved", "write_rejected"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
