// The appearance a person chose, kept on their account so every browser agrees.
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

// Enforced by the server's sign-up and change-password, and stated on each form.
export const PASSWORD_MIN_LENGTH = 12;

/* A profile picture is stored as the small data URL the browser drew, so no file
   is ever served; the server refuses anything else. */
export const AVATAR_SIZE_PX = 256;
export const AVATAR_MAX_LENGTH = 200_000;
export const AVATAR_PATTERN =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

// `ownerExists` is the one question Better Auth cannot answer: it knows whether
// this request is signed in, never whether the install has been set up.
export type AuthStatusResponse =
  | { ownerExists: false }
  | { ownerExists: true; authenticated: false }
  | {
      ownerExists: true;
      authenticated: true;
      email: string;
      name: string;
      image: string | null;
      theme: ThemePreference;
    };
