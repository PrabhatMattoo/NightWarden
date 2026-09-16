import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import type { SessionKind } from "@nightwarden/shared";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { removeSession } from "@/features/session/useSessions";
import { toast } from "@/shared/lib/toast";
import { apiFetch } from "@/shared/api/client";

/* Deleting a session is one act with one failure mode, so both surfaces that
   offer it ask the same question and report the same error. What differs is
   only the noun and where the reader lands afterwards. */
export interface SessionDeletion {
  confirm: () => void;
  dialog: React.JSX.Element;
}

export function useSessionDeletion({
  sessionId,
  kind,
  noun,
  title,
  returnTo,
}: {
  sessionId: string | null;
  kind: SessionKind;
  // "chat" or "investigation", as it reads inside a sentence to the user.
  noun: string;
  // Named in the dialog, so the reader confirms the one they are looking at.
  title: string;
  returnTo: "/agent" | "/investigations";
}): SessionDeletion {
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => {
      if (sessionId !== null) removeSession(queryClient, kind, sessionId);
      void navigate({ to: returnTo });
    },
    onError: (err) => {
      toast.show({
        title: `Could not delete this ${noun}`,
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  return {
    confirm: () => setConfirming(true),
    dialog: (
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={`Delete this ${noun}?`}
        description={`"${title}" and its transcript will be removed permanently.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => remove.mutate()}
      />
    ),
  };
}
