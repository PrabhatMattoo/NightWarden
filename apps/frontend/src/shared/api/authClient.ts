// Better Auth's own client for its routes under /api/auth on this origin; the one other fetch boundary.
import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { THEME_PREFERENCES } from "@nightwarden/shared";

import { ApiError } from "@/shared/api/client";

export const authClient = createAuthClient({
  // The global is read per call rather than captured once, so a stubbed fetch is the one used.
  fetchOptions: { customFetchImpl: (input, init) => fetch(input, init) },
  disableDefaultFetchPlugins: true,
  // Mirrors the server's field, which defaults itself, so sign-up never sends one.
  plugins: [
    inferAdditionalFields({
      user: { theme: { type: [...THEME_PREFERENCES], required: false } },
    }),
  ],
});

type AuthResult<T> =
  | { data: T; error: null }
  | {
      data: null;
      error: { status: number; statusText: string; message?: string };
    };

// A failure throws as an ApiError, so the query cache's 401 check sees auth calls too.
export async function authCall<T>(call: Promise<AuthResult<T>>): Promise<T> {
  const result = await call;
  if (result.error !== null) {
    const { status, statusText, message } = result.error;
    throw new ApiError(status, message ?? statusText, result.error);
  }
  return result.data;
}
