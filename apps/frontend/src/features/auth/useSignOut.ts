import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { authCall, authClient } from "@/shared/api/authClient";
import { authSessionQuery } from "@/features/auth/queries";

/* Everywhere revokes every device first, this one included, so the page lands on
   the login screen. What the account could read leaves the cache with it. */
export function useSignOut({ everywhere = false } = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async () => {
      if (everywhere) await authCall(authClient.revokeSessions());
      await authCall(authClient.signOut());
    },
    onSuccess: async () => {
      const sessionKey = authSessionQuery().queryKey;
      queryClient.setQueryData(sessionKey, null);
      await navigate({ to: "/login" });
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] !== sessionKey[0] ||
          query.queryKey[1] !== sessionKey[1],
      });
    },
  });
}
