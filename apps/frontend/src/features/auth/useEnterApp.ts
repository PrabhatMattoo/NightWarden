import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { authSessionQuery } from "@/features/auth/queries";

// Signed in: the session is read again so the app layout finds it, then the app opens.
export function useEnterApp(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await queryClient.query({ ...authSessionQuery(), staleTime: 0 });
    await navigate({ to: "/" });
  };
}
