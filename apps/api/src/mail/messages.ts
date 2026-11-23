import type { MailMessage } from "./transport.js";

export const RESET_LINK_LIFETIME_S = 60 * 60;
export const INVITATION_LIFETIME_S = 60 * 60 * 24 * 7;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function passwordResetMessage(to: string, url: string): MailMessage {
  const hours = RESET_LINK_LIFETIME_S / 3600;
  const lifetime = `The link works for ${hours} ${hours === 1 ? "hour" : "hours"}.`;
  const ignore =
    "If you did not ask for this, ignore this email and your password stays as it is.";
  return {
    to,
    subject: "Reset your NightWarden password",
    text: `Someone asked to reset the password for this NightWarden account. Open the link to choose a new one.\n\n${url}\n\n${lifetime} ${ignore}\n`,
    html: `<p>Someone asked to reset the password for this NightWarden account. Open the link to choose a new one.</p><p><a href="${escapeHtml(url)}">Choose a new password</a></p><p>${lifetime} ${ignore}</p>`,
  };
}

export function invitationMessage(
  to: string,
  inviterName: string,
  organizationName: string,
  url: string,
): MailMessage {
  const days = INVITATION_LIFETIME_S / 86_400;
  const lifetime = `The link works for ${days} ${days === 1 ? "day" : "days"}.`;
  const ignore =
    "If you were not expecting this, ignore this email and nothing happens.";
  return {
    to,
    subject: `${inviterName} invited you to ${organizationName} on NightWarden`,
    text: `${inviterName} invited you to join ${organizationName} on NightWarden. Open the link to set up your account and join.\n\n${url}\n\n${lifetime} ${ignore}\n`,
    html: `<p>${escapeHtml(inviterName)} invited you to join ${escapeHtml(organizationName)} on NightWarden. Open the link to set up your account and join.</p><p><a href="${escapeHtml(url)}">Join ${escapeHtml(organizationName)}</a></p><p>${lifetime} ${ignore}</p>`,
  };
}
