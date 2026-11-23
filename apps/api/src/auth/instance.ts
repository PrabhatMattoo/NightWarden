import { hash, verify } from "argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import {
  customSession,
  twoFactor as twoFactorPlugin,
} from "better-auth/plugins";
import {
  AVATAR_MAX_LENGTH,
  AVATAR_PATTERN,
  PASSWORD_MIN_LENGTH,
  THEME_FIELD,
  type RoleName,
} from "@nightwarden/shared";
import { themePreferenceSchema } from "@nightwarden/shared/schemas";
import { getDb } from "../db.js";
import { logger } from "../logger.js";
import {
  passwordResetMessage,
  RESET_LINK_LIFETIME_S,
} from "../mail/messages.js";
import { sendMail } from "../mail/transport.js";
import { configuredPublicUrl, extraTrustedOrigins } from "../public-url.js";
import { authSecret } from "../secrets.js";
import {
  account,
  authSession,
  twoFactor,
  user,
  verification,
} from "./schema.js";
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

// A wrong code is slowed per account by the plugin's lockout, so this too only blunts a flood.
const VERIFY_CODE_FLOOD_LIMIT = { window: 60, max: 60 };

const SIGN_IN_PATH = "/sign-in/email";
const SIGN_UP_PATH = "/sign-up/email";
const ENABLE_MFA_PATH = "/two-factor/enable";
const DISABLE_MFA_PATH = "/two-factor/disable";
const VERIFY_TOTP_PATH = "/two-factor/verify-totp";
const VERIFY_BACKUP_CODE_PATH = "/two-factor/verify-backup-code";
// Codes by email are not offered, so their endpoints do not answer.
const EMAIL_CODE_PATHS = ["/two-factor/send-otp", "/two-factor/verify-otp"];

function attemptedEmail(path: string | undefined, body: unknown) {
  if (path !== SIGN_IN_PATH) return undefined;
  if (typeof body !== "object" || body === null || !("email" in body)) {
    return undefined;
  }
  return typeof body.email === "string" ? body.email.toLowerCase() : undefined;
}

// What auth/ needs from the rest of the install, handed in at boot so it imports none of it.
export interface AuthAccess {
  // A null role is an account that belongs to nothing, which the gate refuses on every route.
  accessOf: (userId: string) => { role: RoleName | null; requireMfa: boolean };
  // The name an authenticator lists the account under; undefined keeps NightWarden's.
  mfaIssuer: () => string | undefined;
}

// Refused before the password is checked, so a right password cannot get through while the count stands.
function refuseThrottledSignIn(email: string): void {
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
    Math.ceil((Date.parse(blocking) + SIGN_IN_FAILURE_WINDOW_MS - now) / 1000),
  );
  throw new APIError(
    "TOO_MANY_REQUESTS",
    { message: "Too many failed sign-in attempts. Try again later." },
    { "Retry-After": String(retryAfterS) },
  );
}

// The body a two-factor call carries once NightWarden has had its say, or undefined for any other call.
function twoFactorBody(
  path: string | undefined,
  body: unknown,
  issuer: string | undefined,
) {
  const fields = typeof body === "object" && body !== null ? body : {};
  if (path === ENABLE_MFA_PATH) {
    return issuer === undefined ? undefined : { ...fields, issuer };
  }
  if (path === VERIFY_TOTP_PATH || path === VERIFY_BACKUP_CODE_PATH) {
    // A trusted device would skip the second step for thirty days.
    return { ...fields, trustDevice: false };
  }
  return undefined;
}

let access: AuthAccess | null = null;

export function initAuth(provided: AuthAccess): void {
  access = provided;
}

// Built through a function so the return type keeps the options Better Auth
// infers from this config; naming it erases them and the plugin routes with it.
function buildAuth({ accessOf, mfaIssuer }: AuthAccess) {
  const publicUrl = configuredPublicUrl();
  // The public URL is a trusted origin as well as the address NightWarden
  // answers on; an install reached at a second address names that one too.
  const trusted = [...(publicUrl ? [publicUrl] : []), ...extraTrustedOrigins()];
  const mfa = twoFactorPlugin({
    issuer: "NightWarden",
    // Stated: enabling stays pending until a code from the authenticator verifies.
    skipVerificationOnEnable: false,
    // The same budget as passwords: five wrong codes in a row lock the account for fifteen minutes.
    accountLockout: {
      enabled: true,
      maxFailedAttempts: SIGN_IN_FAILURE_LIMIT,
      durationSeconds: SIGN_IN_FAILURE_WINDOW_MS / 1000,
    },
  });
  return betterAuth({
    // The one handle the stores hold, so both write through one connection.
    database: drizzleAdapter(getDb(), {
      provider: "sqlite",
      schema: { user, session: authSession, account, verification, twoFactor },
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
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === DISABLE_MFA_PATH) {
          const signedIn = await getSessionFromCtx(ctx);
          if (signedIn !== null && accessOf(signedIn.user.id).requireMfa) {
            throw new APIError("FORBIDDEN", {
              message:
                "The organization requires MFA, so it cannot be removed.",
            });
          }
        }
        const body = twoFactorBody(ctx.path, ctx.body, mfaIssuer());
        if (body !== undefined) return { context: { body } };
        const email = attemptedEmail(ctx.path, ctx.body);
        if (email !== undefined) refuseThrottledSignIn(email);
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
    // Nothing calls this over HTTP, so it does not answer; the server still calls it through auth.api.
    disabledPaths: [SIGN_UP_PATH, ...EMAIL_CODE_PATHS],
    emailAndPassword: {
      enabled: true,
      // Sign-up is open to the server alone: the path above is closed to everyone else.
      disableSignUp: false,
      // An account gets a session only by signing in.
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      resetPasswordTokenExpiresIn: RESET_LINK_LIFETIME_S,
      // Whoever held the old password may hold a session; a reset ends them all.
      revokeSessionsOnPasswordReset: true,
      /* Not awaited: a send takes longer for an account that exists, which would
         tell a caller which addresses are accounts. A failure is logged, never thrown. */
      sendResetPassword: ({ user, url }) => {
        sendMail(passwordResetMessage(user.email, url)).catch((err: unknown) =>
          logger.error({ err, userId: user.id }, "password reset email failed"),
        );
        return Promise.resolve();
      },
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
        [VERIFY_TOTP_PATH]: VERIFY_CODE_FLOOD_LIMIT,
        [VERIFY_BACKUP_CODE_PATH]: VERIFY_CODE_FLOOD_LIMIT,
      },
    },
    plugins: [
      mfa,
      customSession(
        ({ user: signedIn, session }) => {
          const { role, requireMfa } = accessOf(signedIn.id);
          return Promise.resolve({
            user: signedIn,
            session,
            role,
            // A member the organization still waits on, which the gate refuses until MFA is set up.
            mfaRequired:
              role !== null && requireMfa && signedIn.twoFactorEnabled !== true,
          });
          // Read for types alone, so the account carries the two-factor field.
        },
        { plugins: [mfa] },
      ),
    ],
  });
}

type Auth = ReturnType<typeof buildAuth>;

let instance: Auth | null = null;

export function getAuth(): Auth {
  if (access === null) {
    throw new Error("auth is not initialised; initAuth() runs at boot");
  }
  instance ??= buildAuth(access);
  return instance;
}

// Paired with resetDb: the instance holds the handle that one closes.
export function resetAuth(): void {
  instance = null;
}
