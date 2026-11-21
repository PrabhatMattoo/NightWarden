// The appearance a person chose, kept on their account so every browser agrees.
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

// The theme field Better Auth declares on the server and mirrors in the browser.
// `required` stays a literal true, which is what Better Auth's types read.
export const THEME_FIELD = {
  type: [...THEME_PREFERENCES],
  required: true as const,
  defaultValue: "system",
  input: true,
};

// Enforced by the server's setup and change-password, and stated on each form.
export const PASSWORD_MIN_LENGTH = 12;

/* A profile picture is stored as the small data URL the browser drew, so no file
   is ever served; the server refuses anything else. */
export const AVATAR_SIZE_PX = 256;
export const AVATAR_MAX_LENGTH = 200_000;
export const AVATAR_PATTERN =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
