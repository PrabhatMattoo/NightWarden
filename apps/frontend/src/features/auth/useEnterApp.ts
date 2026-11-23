import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { authSessionQuery } from "@/features/auth/queries";

// Signed in: the session is read again so the app layout finds it, then the app opens where it was asked.
export function useEnterApp(redirect?: string): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await queryClient.query({ ...authSessionQuery(), staleTime: 0 });
    await (redirect === undefined
      ? navigate({ to: "/" })
      : navigate({ href: redirect }));
  };
}
