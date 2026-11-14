import { useCallback, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/shared/ui/input-group";
import { Label } from "@/shared/ui/label";
import { Toggle } from "@/shared/ui/toggle";
import { toast } from "@/shared/lib/toast";
import { api, dataOrThrow } from "@/shared/api/client";
import { newClientId } from "@/shared/lib/clientId";

interface ChatInputProps {
  sessionId: string | null;
  isRunning: boolean;
  // A closed investigation offers to reopen; the message then becomes the reason.
  reopenable?: boolean;
  onSessionCreated?: (sessionId: string, firstMessage: string) => void;
  onSend?: (text: string, clientMessageId: string) => void;
  // The POST never reached the API: the view rolls back its optimistic state.
  onSendFailed?: () => void;
}

export function ChatInput({
  sessionId,
  isRunning,
  reopenable = false,
  onSessionCreated,
  onSend,
  onSendFailed,
}: ChatInputProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [reopenOn, setReopenOn] = useState(false);
  // Only while the session can be reopened, so a run that starts turns it off.
  const reopening = reopenable && reopenOn;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const navigate = useNavigate();

  const submit = useMutation({
    mutationFn: async (send: {
      message: string;
      clientMessageId: string;
      reopen: boolean;
    }): Promise<string | null> => {
      if (sessionId !== null && send.reopen) {
        await dataOrThrow(
          api.POST("/api/sessions/{id}/reopen", {
            params: { path: { id: sessionId } },
            body: {
              reason: send.message,
              clientMessageId: send.clientMessageId,
            },
          }),
        );
        return null;
      }
      if (sessionId === null) {
        const data = await dataOrThrow(
          api.POST("/api/chat", {
            body: {
              message: send.message,
              clientMessageId: send.clientMessageId,
            },
          }),
        );
        onSessionCreated?.(data.sessionId, send.message);
        return data.sessionId;
      }
      await dataOrThrow(
        api.POST("/api/sessions/{id}/messages", {
          params: { path: { id: sessionId } },
          body: {
            message: send.message,
            clientMessageId: send.clientMessageId,
          },
        }),
      );
      return null;
    },
    onSuccess: async (createdSessionId, sent) => {
      if (sent.reopen) setReopenOn(false);
      if (createdSessionId !== null) {
        await navigate({
          to: "/agent/$id",
          params: { id: createdSessionId },
          replace: true,
        });
      }
      textareaRef.current?.focus();
    },
    onError: (err, failed) => {
      // Restore the message unless the user already typed something new.
      setText((current) => (current === "" ? failed.message : current));
      onSendFailed?.();
      toast.show({
        title: failed.reopen
          ? "Could not reopen the investigation"
          : "Message not sent",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const stop = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/sessions/{id}/stop", {
          params: { path: { id: sessionId ?? "" } },
        }),
      ),
    onError: (err) => {
      toast.show({
        title: "Could not stop the run",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isRunning || submit.isPending) return;
    // Cleared at submit, not on success: the echoed bubble is the message now.
    setText("");
    const clientMessageId = newClientId();
    onSend?.(trimmed, clientMessageId);
    submit.mutate({ message: trimmed, clientMessageId, reopen: reopening });
  }, [text, isRunning, submit, onSend, reopening]);

  const canSend = text.trim().length > 0 && !isRunning && !submit.isPending;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey || composingRef.current) return;
      if (window.matchMedia("(pointer: coarse)").matches) return;
      e.preventDefault();
      handleSubmit();
    },
    [handleSubmit],
  );

  return (
    <div className="conversation-column pb-4 pt-2 max-md:pb-3">
      <Label htmlFor="chat-textarea" className="sr-only">
        Message
      </Label>
      <InputGroup variant="composer" className="w-full">
        <InputGroupTextarea
          ref={textareaRef}
          id="chat-textarea"
          className="max-h-50"
          placeholder={
            isRunning
              ? "Agent is running…"
              : reopening
                ? "Why reopen it, and what should it look at?"
                : "Ask NightWarden…"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          unavailable={isRunning}
          rows={3}
        />
        <InputGroupAddon
          align="block-end"
          className="justify-between gap-2 px-2 pb-2"
        >
          {reopenable ? (
            <Toggle pressed={reopenOn} onPressedChange={setReopenOn}>
              <RotateCcw aria-hidden />
              Reopen investigation
            </Toggle>
          ) : (
            <span />
          )}
          {isRunning ? (
            <InputGroupButton
              type="button"
              variant="default"
              size="send"
              aria-label="Stop generating"
              onClick={() => sessionId !== null && stop.mutate()}
              disabled={stop.isPending}
            >
              <Square strokeWidth={2.25} aria-hidden />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="button"
              variant="default"
              size="send"
              aria-label="Send message"
              onClick={handleSubmit}
              disabled={!canSend}
            >
              <ArrowUp strokeWidth={2.25} aria-hidden />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
