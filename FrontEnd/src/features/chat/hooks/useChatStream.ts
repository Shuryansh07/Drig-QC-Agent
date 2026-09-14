import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch } from "@/app/hooks";
import { chatActions } from "@/features/chat/chatSlice";
import { outboxActions } from "@/features/outbox/outboxSlice";
import { apiUrl, authHeaders } from "@/lib/api-client";
import { drainFrames, parseSSE } from "@/lib/sse";
import { queryKeys } from "@/lib/query-client";
import { isOnline } from "@/lib/offline";
import type { Conversation, QueryFrame, ServerEvent } from "@/types/contracts";

/**
 * Not `useQuery`. `EventSource` cannot attach an auth header, so this is `fetch`
 * with a readable stream (§4).
 */
export function useChatStream(sessionId: string) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string, frame?: Partial<QueryFrame>) => {
      if (!isOnline()) {
        // §9: queued, persisted, sent on reconnect. No spinner, no failure toast.
        dispatch(outboxActions.queued({ sessionId, text }));
        return;
      }

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      dispatch(chatActions.streamStarted());

      try {
        const res = await fetch(apiUrl("/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeaders()) },
          body: JSON.stringify({ sessionId, text, frame }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Stream failed with ${res.status}`);
        }

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += value;
          const { frames, rest } = drainFrames(buffer);
          buffer = rest;

          for (const raw of frames) {
            const event = parseSSE(raw);
            if (!event) continue;
            dispatch(chatActions.serverEvent(event));
            if (event.type === "done") commitTurn(event);
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        dispatch(
          chatActions.serverEvent({
            type: "error",
            code: "stream_failed",
            message: err instanceof Error ? err.message : "The connection dropped.",
          }),
        );
      }

      function commitTurn(event: Extract<ServerEvent, { type: "done" }>) {
        // §3: one source of truth at rest, one buffer in motion. The finished
        // turn moves into the query cache and the buffer is cleared.
        queryClient.setQueryData<Conversation>(
          queryKeys.conversation(sessionId),
          (prev) =>
            prev
              ? { ...prev, turns: [...prev.turns, event.turn] }
              : { sessionId, turns: [event.turn], frame: null },
        );
        dispatch(chatActions.clearStream());
      }
    },
    [sessionId, dispatch, queryClient],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    dispatch(chatActions.streamCancelled());
  }, [dispatch]);

  return { send, cancel };
}
