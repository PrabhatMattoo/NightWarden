import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { ApiError } from "@/shared/api/client";
import { toast } from "@/shared/lib/toast";

/* What a page says when a connect attempt never reached us. A failure the API
   answered carries its own words, so only the silence needs supplying. */
export function connectMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Could not reach the API";
}

// The one step every integration performs identically. Connecting is not here:
// each product asks for different fields, and a shared shape would hide that.
export function useDisconnect({
  label,
  queryKey,
  request,
}: {
  label: string;
  queryKey: readonly unknown[];
  request: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: request,
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
  request,
}: {
  label: string;
  queryKey: readonly unknown[];
  request: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
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
