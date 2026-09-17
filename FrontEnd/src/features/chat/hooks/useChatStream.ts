import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch } from "@/app/hooks";
import { chatActions } from "@/features/chat/chatSlice";
import { outboxActions } from "@/features/outbox/outboxSlice";
import { apiFetch, ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { isOnline } from "@/lib/offline";
import type { AnswerStep, Citation, Conversation, Turn } from "@/types/contracts";

interface RagQueryResponse {
  answer: string;
  sources: { document_id: string; page_number: number }[];
}

// No auth/tenant selection UI exists yet (AuthProvider is a stub — see
// features/auth/AuthProvider.tsx), so there's no real customer_id to read.
// "default" matches what most of the test documents were uploaded under.
const CUSTOMER_ID = "default";

const appendTurn = (
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
  turn: Turn,
) => {
  queryClient.setQueryData<Conversation>(queryKeys.conversation(sessionId), (prev) =>
    prev
      ? { ...prev, turns: [...prev.turns, turn] }
      : { sessionId, turns: [turn], frame: null },
  );
};

/**
 * Was SSE streaming against a `/chat` endpoint that was never built. The
 * real backend (BackEnd/src/controllers/rag.controller.js) is one-shot:
 * POST /rag/query -> { answer, sources }, no streaming. This adapts that
 * single response into the same Redux/query-cache events the rest of the
 * chat UI (TurnView, StreamingTurnView, AnswerSteps, citations) already
 * consumes, so none of that rendering code had to change — the "thinking"
 * skeleton just resolves straight to the finished answer instead of tokens
 * arriving incrementally.
 *
 * Fields the real backend has no data for (frame, clarify, notCovered,
 * conflict, deadlineWarning) are simply never dispatched, rather than
 * faked — better an empty state than an invented one.
 */
export function useChatStream(sessionId: string) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!isOnline()) {
        // §9: queued, persisted, sent on reconnect. No spinner, no failure toast.
        dispatch(outboxActions.queued({ sessionId, text: trimmed }));
        return;
      }

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      appendTurn(queryClient, sessionId, {
        turnId: crypto.randomUUID(),
        role: "technician",
        text: trimmed,
        steps: [],
        citations: [],
        gateOutcome: null,
        clarify: null,
        notCovered: null,
        conflict: null,
        resolution: null,
        createdAt: new Date().toISOString(),
      });

      dispatch(chatActions.streamStarted());
      const requestStart = performance.now();

      try {
        const response = await apiFetch<RagQueryResponse>("/rag/query", {
          method: "POST",
          body: JSON.stringify({ customer_id: CUSTOMER_ID, question: trimmed }),
          signal: ctrl.signal,
        });

        if (ctrl.signal.aborted) return;

        const durationMs = Math.round(performance.now() - requestStart);

        const citations: Citation[] = Array.from(
          new Map(
            response.sources.map((s) => [
              `${s.document_id}:${s.page_number}`,
              {
                chunkId: `${s.document_id}:${s.page_number}`,
                kind: "document" as const,
                label: `Page ${s.page_number}`,
                locator: `Page ${s.page_number}`,
                documentId: s.document_id,
              },
            ]),
          ).values(),
        );

        const step: AnswerStep = {
          n: 1,
          text: response.answer,
          sourceChunkIds: citations.map((c) => c.chunkId),
        };

        dispatch(chatActions.serverEvent({ type: "step", step }));
        for (const citation of citations) {
          dispatch(chatActions.serverEvent({ type: "citation", citation }));
        }

        const turn: Turn = {
          turnId: crypto.randomUUID(),
          role: "agent",
          text: response.answer,
          steps: [step],
          citations,
          gateOutcome: "answered",
          clarify: null,
          notCovered: null,
          conflict: null,
          resolution: null,
          createdAt: new Date().toISOString(),
          durationMs,
        };

        dispatch(chatActions.serverEvent({ type: "done", turn }));
        appendTurn(queryClient, sessionId, turn);
        dispatch(chatActions.clearStream());
      } catch (err) {
        if (ctrl.signal.aborted) return;
        dispatch(
          chatActions.serverEvent({
            type: "error",
            code: err instanceof ApiError ? err.code : "network_error",
            message: err instanceof Error ? err.message : "The connection dropped.",
          }),
        );
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
