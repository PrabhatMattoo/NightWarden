// The cached session changes first, so the page repaints before the account write lands.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ThemePreference } from "@nightwarden/shared";

import { authCall, authClient } from "@/shared/api/authClient";
import { toast } from "@/shared/lib/toast";
import { authSessionQuery } from "@/features/auth/queries";

export function useSetTheme() {
  const queryClient = useQueryClient();
  const { queryKey } = authSessionQuery();
  return useMutation({
    mutationFn: (theme: ThemePreference) =>
      authCall(authClient.updateUser({ theme })),
    onMutate: (theme) => {
      const before = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (session) =>
        session ? { ...session, user: { ...session.user, theme } } : session,
      );
      return { before };
    },
    onError: (err, _theme, context) => {
      queryClient.setQueryData(queryKey, context?.before);
      toast.show({
        title: "Appearance not saved",
        message: err.message,
        variant: "error",
      });
    },
  });
}
