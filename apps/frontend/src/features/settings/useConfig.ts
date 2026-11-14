import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { AgentConfig, SettingsPatch } from "@nightwarden/shared";

import { api, dataOrThrow } from "@/shared/api/client";
import { toast } from "@/shared/lib/toast";
import { configQuery } from "./queries";

const KEY = configQuery().queryKey;

export function useConfig(): AgentConfig {
  return useSuspenseQuery(configQuery()).data;
}

// A value valid on its own writes when committed, so there is nothing to save.
// A rejected write puts the previous value back rather than claiming success.
export function useConfigAutosave(): (patch: SettingsPatch) => void {
  const queryClient = useQueryClient();
  const { mutate } = useMutation<
    AgentConfig,
    Error,
    SettingsPatch,
    { previous: AgentConfig | undefined }
  >({
    mutationFn: (patch) =>
      dataOrThrow(api.PATCH("/api/config", { body: patch })),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const previous = queryClient.getQueryData<AgentConfig>(KEY);
      if (previous) queryClient.setQueryData(KEY, { ...previous, ...patch });
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(KEY, context.previous);
      toast.show({
        title: "Save failed",
        message: error.message,
        variant: "error",
      });
    },
  });
  return mutate;
}
