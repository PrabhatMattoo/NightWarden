import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { AuthStatusResponse, ThemePreference } from "@nightwarden/shared";

import { apiFetch } from "@/shared/api/client";
import { applyTheme, followSystem } from "@/shared/lib/appearance";

import { installFetchInterceptor } from "./fetchInterceptor.js";

type AuthPhase =
  | { kind: "loading" }
  | { kind: "needs-setup" }
  | { kind: "needs-login" }
  | {
      kind: "authenticated";
      email: string;
      name: string;
      theme: ThemePreference;
    };

export type AuthActionResult = { ok: true } | { ok: false; error: string };

function phaseFromStatus(status: AuthStatusResponse): AuthPhase {
  if (!status.ownerExists) return { kind: "needs-setup" };
  if (!status.authenticated) return { kind: "needs-login" };
  const { email, name, theme } = status;
  return { kind: "authenticated", email, name, theme };
}

async function post(
  path: string,
  body: Record<string, string>,
): Promise<AuthActionResult> {
  try {
    await apiFetch<unknown>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "request failed",
    };
  }
}

async function readStatus(): Promise<AuthPhase> {
  try {
    return phaseFromStatus(
      await apiFetch<AuthStatusResponse>("/api/auth-status"),
    );
  } catch {
    // A failed status check falls back to the login page, never an endless load.
    return { kind: "needs-login" };
  }
}

interface AuthContextValue {
  phase: AuthPhase;
  login: (email: string, password: string) => Promise<AuthActionResult>;
  signup: (
    name: string,
    email: string,
    password: string,
  ) => Promise<AuthActionResult>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  setTheme: (theme: ThemePreference) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [phase, setPhase] = useState<AuthPhase>({ kind: "loading" });

  // Signed in or not, the status read is what the whole app waits on.
  const refresh = useCallback(async () => setPhase(await readStatus()), []);

  useEffect(() => {
    let live = true;
    void readStatus().then((next) => {
      if (live) setPhase(next);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(
    () => installFetchInterceptor(() => setPhase({ kind: "needs-login" })),
    [],
  );

  const theme = phase.kind === "authenticated" ? phase.theme : null;
  useEffect(() => {
    if (theme === null) return;
    applyTheme(theme);
    return followSystem(theme);
  }, [theme]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await post("/api/auth/sign-in/email", { email, password });
      if (result.ok) await refresh();
      return result;
    },
    [refresh],
  );

  const signup = useCallback(
    async (name: string, email: string, password: string) => {
      const result = await post("/api/auth/sign-up/email", {
        name,
        email,
        password,
      });
      if (result.ok) await refresh();
      return result;
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await apiFetch<unknown>("/api/auth/sign-out", { method: "POST" });
    setPhase({ kind: "needs-login" });
  }, []);

  // Every device, this one included, so the page returns to the login screen.
  const logoutAll = useCallback(async () => {
    await apiFetch<unknown>("/api/auth/revoke-sessions", { method: "POST" });
    await apiFetch<unknown>("/api/auth/sign-out", { method: "POST" });
    setPhase({ kind: "needs-login" });
  }, []);

  // Painted at once and then saved, so the choice never waits on the network.
  const setTheme = useCallback(async (next: ThemePreference) => {
    setPhase((prev) =>
      prev.kind === "authenticated" ? { ...prev, theme: next } : prev,
    );
    await apiFetch<unknown>("/api/auth/update-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: next }),
    });
  }, []);

  return (
    <AuthContext.Provider
      value={{ phase, login, signup, logout, logoutAll, setTheme }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}
