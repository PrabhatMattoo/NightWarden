import { hash, verify } from "argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
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
import {
  clearSignInFailures,
  recordSignInFailure,
  signInFailuresSince,
} from "./sign-in-failure-store.js";

// The only header Better Auth reads the client address from; the auth route sets it from Fastify.
export const CLIENT_IP_HEADER = "x-nightwarden-client-ip";

const SESSION_LIFETIME_S = 60 * 60 * 24 * 30;
const SESSION_REFRESH_INTERVAL_S = 60 * 60 * 24;

// Loose, since the per-account throttle below carries the protection.
const SIGN_IN_FLOOD_LIMIT = { window: 60, max: 60 };
const CHANGE_PASSWORD_LIMIT = { window: 60, max: 5 };

const SIGN_IN_FAILURE_LIMIT = 5;
const SIGN_IN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

const SIGN_IN_PATH = "/sign-in/email";

function attemptedEmail(path: string | undefined, body: unknown) {
  if (path !== SIGN_IN_PATH) return undefined;
  if (typeof body !== "object" || body === null || !("email" in body)) {
    return undefined;
  }
  return typeof body.email === "string" ? body.email.toLowerCase() : undefined;
}

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
    advanced: {
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    session: {
      expiresIn: SESSION_LIFETIME_S,
      updateAge: SESSION_REFRESH_INTERVAL_S,
    },
    hooks: {
      // Refused before the password is checked, so a right password cannot get
      // through while the count stands.
      before: createAuthMiddleware(async (ctx) => {
        const email = attemptedEmail(ctx.path, ctx.body);
        if (email === undefined) return;
        const now = Date.now();
        const failures = signInFailuresSince(
          email,
          new Date(now - SIGN_IN_FAILURE_WINDOW_MS).toISOString(),
        );
        // Sign-in reopens once enough failures have aged out to leave four.
        const blocking = failures[failures.length - SIGN_IN_FAILURE_LIMIT];
        if (blocking === undefined) return;
        const retryAfterS = Math.max(
          1,
          Math.ceil(
            (Date.parse(blocking) + SIGN_IN_FAILURE_WINDOW_MS - now) / 1000,
          ),
        );
        throw new APIError(
          "TOO_MANY_REQUESTS",
          { message: "Too many failed sign-in attempts. Try again later." },
          { "Retry-After": String(retryAfterS) },
        );
      }),
      after: createAuthMiddleware(async (ctx) => {
        const email = attemptedEmail(ctx.path, ctx.body);
        if (email === undefined) return;
        const { returned } = ctx.context;
        if (!isAPIError(returned)) {
          clearSignInFailures(email);
        } else if (returned.statusCode === 401) {
          const now = Date.now();
          recordSignInFailure(
            email,
            new Date(now).toISOString(),
            new Date(now - SIGN_IN_FAILURE_WINDOW_MS).toISOString(),
          );
        }
      }),
    },
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
      // The default turns the limiter off outside production, so dev and tests never ran it.
      enabled: true,
      customRules: {
        [SIGN_IN_PATH]: SIGN_IN_FLOOD_LIMIT,
        "/change-password": CHANGE_PASSWORD_LIMIT,
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
