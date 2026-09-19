import type { AuthStatusResponse } from "@nightwarden/shared";

// A 401 can mean the session lapsed or that a data route forwarded an upstream
// credential failure, so we ask the auth authority rather than infer a sign-out.
export function installFetchInterceptor(
  onUnauthorized: () => void,
): () => void {
  const original = window.fetch;

  async function stillAuthenticated(): Promise<boolean> {
    try {
      const res = await original("/api/auth-status");
      const status = (await res.json()) as AuthStatusResponse;
      return status.ownerExists === true && status.authenticated === true;
    } catch {
      // A check that itself fails is no proof the session died, so leave it be.
      return true;
    }
  }

  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    // The auth routes own their own 401s (a wrong password, the check below), so
    // only a 401 from a data route asks whether the session is the one at fault.
    if (response.status === 401 && !urlOf(args[0]).includes("/api/auth")) {
      if (!(await stillAuthenticated())) onUnauthorized();
    }
    return response;
  };
  return () => {
    window.fetch = original;
  };
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
