import type { AuditEvent } from "@nightwarden/shared";

import { ROLE_LABEL } from "@/shared/lib/roles";

function writeSentence(
  verb: string,
  event: Extract<AuditEvent, { action: "write_approved" | "write_rejected" }>,
): string {
  const { tool, reason } = event.details;
  const on = event.target === null ? "" : ` on ${event.target}`;
  const why = reason === undefined ? "" : `, saying "${reason}"`;
  return `${verb} ${tool}${on}${why}`;
}

// What happened, in a sentence the actor's name can stand before.
export function auditSentence(event: AuditEvent): string {
  switch (event.action) {
    case "write_approved":
      return writeSentence("Approved", event);
    case "write_rejected":
      return writeSentence("Rejected", event);
    case "organization_created":
      return `Created the organization ${event.details.name}`;
    case "organization_updated":
      return `Changed the organization's ${event.details.fields.join(" and ")}`;
    case "member_added":
      return `Added ${event.details.email} as ${ROLE_LABEL[event.details.role]}`;
    case "member_invited":
      return `Invited ${event.details.email} as ${ROLE_LABEL[event.details.role]}`;
    case "invitation_canceled":
      return `Canceled the invitation for ${event.details.email}`;
    case "member_joined":
      return `${event.details.email} joined as ${ROLE_LABEL[event.details.role]}`;
    case "member_role_changed":
      return `Changed ${event.details.email} from ${ROLE_LABEL[event.details.previousRole]} to ${ROLE_LABEL[event.details.role]}`;
    case "member_removed":
      return `Removed ${event.details.email}, who was ${ROLE_LABEL[event.details.role]}`;
    case "team_created":
      return `Created the team ${event.details.name}`;
    case "team_renamed":
      return `Renamed the team ${event.details.previousName} to ${event.details.name}`;
    case "team_deleted":
      return `Deleted the team ${event.details.name}`;
    case "team_member_added":
      return `Added ${event.details.email} to the team ${event.details.team}`;
    case "team_member_removed":
      return `Removed ${event.details.email} from the team ${event.details.team}`;
    case "mfa_requirement_changed":
      return event.details.required
        ? "Required MFA for everyone"
        : "Made MFA optional";
    case "mfa_reset":
      return `Reset MFA for ${event.details.email}`;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
