import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { ApiError, apiFetch } from "@/shared/api/client";
import { toast } from "@/shared/lib/toast";

/* What a page says when a connect attempt never reached us. A failure the API
   answered carries its own words, so only the silence needs supplying. */
export function connectMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Could not reach the API";
}

// The one step every integration performs identically. Connecting is not here:
// each product asks for different fields, and a shared shape would hide that.
export function useDisconnect<TVars = void>({
  label,
  queryKey,
  endpoint,
}: {
  label: string;
  queryKey: readonly unknown[];
  endpoint: (vars: TVars) => string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (vars: TVars) =>
      apiFetch<void>(endpoint(vars), { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(`${label} disconnected`);
      await queryClient.invalidateQueries({ queryKey });
      void navigate({ to: "/integrations" });
    },
    onError: (err) =>
      toast.show({
        title: "Could not disconnect",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });
}

/* A refusal is recorded by the API before it answers, so both outcomes refetch:
   the page then shows the state the server just wrote. */
export function useTestConnection({
  label,
  queryKey,
  endpoint,
}: {
  label: string;
  queryKey: readonly unknown[];
  endpoint: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<unknown>(endpoint, { method: "POST" }),
    onSuccess: () => toast.success(`${label} connection works`),
    onError: (err) =>
      toast.show({
        title: `${label} did not answer`,
        message: connectMessage(err),
        variant: "error",
      }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
}
