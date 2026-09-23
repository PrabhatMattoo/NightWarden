// The appearance a person chose, kept on their account so every browser agrees.
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

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
      theme: ThemePreference;
    };
