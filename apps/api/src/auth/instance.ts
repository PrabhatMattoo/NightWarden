import { hash, verify } from "argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import {
  AVATAR_MAX_LENGTH,
  AVATAR_PATTERN,
  PASSWORD_MIN_LENGTH,
  THEME_FIELD,
} from "@nightwarden/shared";
import { themePreferenceSchema } from "@nightwarden/shared/schemas";
import { getDb } from "../db.js";
import { configuredPublicUrl, extraTrustedOrigins } from "../public-url.js";
import { authSecret } from "../secrets.js";
import { MEMBER_ROLE } from "./permissions.js";
import { account, authSession, user, verification } from "./schema.js";

// Five attempts a minute on the credential paths; Better Auth's own default of
// 100 per 10s would let a password be guessed far faster.
const SIGN_IN_LIMIT = { window: 60, max: 5 };

// Built through a function so the return type keeps the options Better Auth
// infers from this config; naming it erases them and the plugin routes with it.
function buildAuth() {
  const publicUrl = configuredPublicUrl();
  // The public URL is a trusted origin as well as the address NightWarden
  // answers on; an install reached at a second address names that one too.
  const trusted = [...(publicUrl ? [publicUrl] : []), ...extraTrustedOrigins()];
  const adminPlugin = admin({ defaultRole: MEMBER_ROLE });
  return betterAuth({
    // The one handle the stores hold, so both write through one connection.
    database: drizzleAdapter(getDb(), {
      provider: "sqlite",
      schema: { user, session: authSession, account, verification },
    }),
    secret: authSecret(),
    ...(publicUrl !== undefined && { baseURL: publicUrl }),
    ...(trusted.length > 0 && { trustedOrigins: trusted }),
    // Stated rather than inferred: the default turns this check off under a
    // test runner, so the suite would never exercise it.
    advanced: { disableOriginCheck: false },
    // Nothing calls the plugin over HTTP, so none of its paths, impersonation
    // among them, answers; the server still calls them through auth.api.
    disabledPaths: Object.values(adminPlugin.endpoints).map(
      (endpoint) => endpoint.path,
    ),
    emailAndPassword: {
      enabled: true,
      // Accounts are created in-process: the owner by the setup route.
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      // OWASP's first recommendation, and the package's defaults already exceed
      // its floor at 64 MiB, 3 iterations and parallelism 4.
      password: {
        hash: (password) => hash(password),
        verify: ({ hash: stored, password }) => verify(stored, password),
      },
    },
    user: {
      // Kept on the account so every browser a person signs in from agrees.
      additionalFields: {
        theme: { ...THEME_FIELD, validator: { input: themePreferenceSchema } },
      },
    },
    databaseHooks: {
      user: {
        update: {
          // Rendered as an <img> on every page, so only a small inline picture is kept.
          before: async (changes) => {
            const { image } = changes;
            if (
              typeof image === "string" &&
              (image.length > AVATAR_MAX_LENGTH || !AVATAR_PATTERN.test(image))
            ) {
              throw new APIError("BAD_REQUEST", {
                message: "A profile picture must be a PNG, JPEG or WebP image.",
              });
            }
            return { data: changes };
          },
        },
      },
    },
    rateLimit: {
      // `enabled` is left to Better Auth, which runs the limiter in production
      // and not in development.
      customRules: {
        "/sign-in/email": SIGN_IN_LIMIT,
        "/change-password": SIGN_IN_LIMIT,
      },
    },
    plugins: [adminPlugin],
  });
}

type Auth = ReturnType<typeof buildAuth>;

let instance: Auth | null = null;

export function getAuth(): Auth {
  instance ??= buildAuth();
  return instance;
}

// Paired with resetDb: the instance holds the handle that one closes.
export function resetAuth(): void {
  instance = null;
}
