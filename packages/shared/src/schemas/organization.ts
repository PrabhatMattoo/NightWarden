import { z } from "zod";
import { AVATAR_MAX_LENGTH, AVATAR_PATTERN } from "../auth.js";
import { ROLE_NAMES } from "../roles.js";

const roleSchema = z.enum(ROLE_NAMES);
const name = z.string().trim().min(1).max(100);
export const organizationNameSchema = name;
const logo = z
  .string()
  .max(AVATAR_MAX_LENGTH)
  .regex(AVATAR_PATTERN, "A logo must be a PNG, JPEG or WebP image.");

export const organizationSchema = z.object({
  name: z.string(),
  logo: z.string().nullable(),
  // Whether every person must set up MFA before using the app.
  requireMfa: z.boolean(),
  // The variable that sets a field, which the page tells an admin to unset.
  locked: z.partialRecord(z.enum(["requireMfa"]), z.string()),
});
export type Organization = z.infer<typeof organizationSchema>;

export const organizationPatchSchema = z.object({
  name: organizationNameSchema.optional(),
  logo: logo.nullable().optional(),
  requireMfa: z.boolean().optional(),
});

const teamRefSchema = z.object({ id: z.string(), name: z.string() });

const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  role: roleSchema,
  mfaEnabled: z.boolean(),
  joinedAt: z.string(),
  teams: z.array(teamRefSchema),
});
export type OrganizationMember = z.infer<typeof memberSchema>;
export const memberListSchema = z.array(memberSchema);

export const memberRolePatchSchema = z.object({ role: roleSchema });

const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  // Null once the account that invited them is gone.
  inviterName: z.string().nullable(),
  expiresAt: z.string(),
  teams: z.array(teamRefSchema),
});
export type OrganizationInvitation = z.infer<typeof invitationSchema>;
export const invitationListSchema = z.array(invitationSchema);

export const inviteRequestSchema = z.object({
  email: z.email(),
  role: roleSchema,
  teamIds: z.array(z.string()).optional(),
});

const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  // The team setup made, which members and integrations fall back to and which stays.
  isDefault: z.boolean(),
  createdAt: z.string(),
  memberCount: z.number(),
});
export type OrganizationTeam = z.infer<typeof teamSchema>;
export const teamListSchema = z.array(teamSchema);
export const teamCreatedSchema = teamRefSchema;

export const teamRequestSchema = z.object({ name });
export const teamMemberRequestSchema = z.object({ userId: z.string().min(1) });

// What the invitation link's page shows before the person chooses a password.
export const invitationPreviewSchema = z.object({
  email: z.string(),
  organizationName: z.string(),
  role: roleSchema,
  inviterName: z.string().nullable(),
  // A removed member invited again signs in with their own password.
  accountExists: z.boolean(),
  expired: z.boolean(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

// Only a new account sends these; an existing one joins with the session it signed in with.
export const acceptInvitationRequestSchema = z.object({
  name: name.optional(),
  password: z.string().min(1).optional(),
});
