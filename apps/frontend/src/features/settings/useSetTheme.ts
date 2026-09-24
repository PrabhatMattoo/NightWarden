// The cached status changes first, so the page repaints before the account write lands.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ThemePreference } from "@nightwarden/shared";

import { authCall, authClient } from "@/shared/api/authClient";
import { toast } from "@/shared/lib/toast";
import { authStatusQuery, isSignedIn } from "@/features/auth/queries";

export function useSetTheme() {
  const queryClient = useQueryClient();
  const { queryKey } = authStatusQuery();
  return useMutation({
    mutationFn: (theme: ThemePreference) =>
      authCall(authClient.updateUser({ theme })),
    onMutate: (theme) => {
      const before = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (status) =>
        status !== undefined && isSignedIn(status)
          ? { ...status, theme }
          : status,
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
