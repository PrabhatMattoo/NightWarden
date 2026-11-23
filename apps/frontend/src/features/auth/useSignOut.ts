import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { authCall, authClient } from "@/shared/api/authClient";
import { authSessionQuery } from "@/features/auth/queries";

/* The page lands on the login screen, which returns to `redirect` once someone
   signs in. What the account could read leaves the cache with it. */
export function useSignOut({ redirect }: { redirect?: string } = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => authCall(authClient.signOut()),
    onSuccess: async () => {
      const sessionKey = authSessionQuery().queryKey;
      queryClient.setQueryData(sessionKey, null);
      await navigate({
        to: "/login",
        search: redirect === undefined ? {} : { redirect },
      });
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] !== sessionKey[0] ||
          query.queryKey[1] !== sessionKey[1],
      });
    },
  });
}
