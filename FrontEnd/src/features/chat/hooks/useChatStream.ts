import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch } from "@/app/hooks";
import { chatActions } from "@/features/chat/chatSlice";
import { outboxActions } from "@/features/outbox/outboxSlice";
import { parseWireEvent, type WireSource } from "@/features/chat/streamEvents";
import { apiUrl, authHeaders, ApiError } from "@/lib/api-client";
import { readSSEFrames } from "@/lib/sse";
import { queryKeys } from "@/lib/query-client";
import { isOnline } from "@/lib/offline";
import { logger } from "@/lib/logger";
import type { AnswerStep, Citation, Conversation, NotCoveredInfo, Turn } from "@/types/contracts";

// No auth/tenant selection UI exists yet (AuthProvider is a stub — see
// features/auth/AuthProvider.tsx), so there's no real customer_id to read.
const CUSTOMER_ID = "default";

/**
 * How long with no answer text before the UI says it is taking longer than
 * usual. A technician staring at a spinner assumes the app is broken within
 * about ten seconds, so this speaks well before that. The hard deadline
 * (gate.deadline_ms, 22s) is separate and comes from the server.
 */
const SLOW_AFTER_MS = 5_000;

const appendTurn = (queryClient: ReturnType<typeof useQueryClient>, sessionId: string, turn: Turn) => {
  queryClient.setQueryData<Conversation>(queryKeys.conversation(sessionId), (prev) =>
    prev ? { ...prev, turns: [...prev.turns, turn] } : { sessionId, turns: [turn], frame: null },
  );
};

/** "T200-install-guide.docx" -> "T200-install-guide". */
const docName = (title: string | null | undefined): string => (title ?? "").replace(/\.(pdf|docx)$/i, "");

const toCitations = (sources: WireSource[]): Citation[] =>
  Array.from(
    new Map(
      sources.map((s) => {
        // The last heading in the path is the most specific place to look.
        const section = s.section_path?.split(" > ").pop() ?? "";
        const paged = s.page_number !== null && s.page_number !== undefined;
        const chunkId = `${s.document_id}:${paged ? s.page_number : section || "document"}`;
        const citation: Citation = {
          chunkId,
          kind: "document",
          // A PDF is cited by page, then section. A Word file has no pages, so it is cited by
          // document AND section: two Word files can both have a "Wiring" section.
          label: paged ? `Page ${s.page_number}` : [docName(s.document_title), section].filter(Boolean).join(" · ") || "Document",
          locator: paged ? section : "",
          documentId: s.document_id,
        };
        return [chunkId, citation];
      }),
    ).values(),
  );

const agentTurn = (overrides: Partial<Turn>): Turn => ({
  turnId: crypto.randomUUID(),
  role: "agent",
  text: "",
  steps: [],
  citations: [],
  gateOutcome: null,
  clarify: null,
  notCovered: null,
  conflict: null,
  resolution: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

/**
 * Asks POST /api/rag/query/stream and turns the server-sent events into the
 * Redux/query-cache updates the chat UI already renders: a stage label while
 * the server searches, sources as soon as they are known, then the answer
 * token by token, then the finished turn committed into the conversation.
 *
 * Fields the real backend has no data for (frame, clarify, conflict) are
 * simply never dispatched, rather than faked.
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
      const slowTimer = window.setTimeout(() => dispatch(chatActions.slowResponse()), SLOW_AFTER_MS);

      // Tokens arrive far faster than the screen refreshes. Collect them and
      // dispatch once per frame, so a fast stream is not one re-render per word.
      let pendingText = "";
      let frame = 0;
      const flushText = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        if (pendingText) {
          dispatch(chatActions.answerDelta(pendingText));
          pendingText = "";
        }
      };

      let citations: Citation[] = [];
      let finished = false;

      const commitAnswer = (answer: string, durationMs: number) => {
        const step: AnswerStep = { n: 1, text: answer, sourceChunkIds: citations.map((c) => c.chunkId) };
        const turn = agentTurn({ text: answer, steps: [step], citations, gateOutcome: "answered", durationMs });
        dispatch(chatActions.serverEvent({ type: "done", turn }));
        appendTurn(queryClient, sessionId, turn);
        dispatch(chatActions.clearStream());
      };

      const commitRefusal = (notCovered: NotCoveredInfo) => {
        // No durationMs: "Answered in Xms" under a refusal would be false.
        const turn = agentTurn({ text: notCovered.message, gateOutcome: "not_covered", notCovered });
        dispatch(chatActions.serverEvent({ type: "not_covered", notCovered }));
        dispatch(chatActions.serverEvent({ type: "done", turn }));
        appendTurn(queryClient, sessionId, turn);
        dispatch(chatActions.clearStream());
      };

      try {
        const response = await fetch(apiUrl("/rag/query/stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(await authHeaders()) },
          body: JSON.stringify({ customer_id: CUSTOMER_ID, question: trimmed }),
          signal: ctrl.signal,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
          throw new ApiError(response.status, body.code ?? "unknown", body.message ?? response.statusText);
        }

        for await (const rawFrame of readSSEFrames(response)) {
          const event = parseWireEvent(rawFrame);
          if (!event) continue;

          switch (event.type) {
            case "stage":
              dispatch(chatActions.stageChanged(event.stage));
              break;

            case "sources":
              citations = toCitations(event.sources);
              for (const citation of citations) {
                dispatch(chatActions.serverEvent({ type: "citation", citation }));
              }
              break;

            case "delta":
              pendingText += event.text;
              if (!frame) frame = requestAnimationFrame(flushText);
              break;

            case "deadline_warning":
              dispatch(chatActions.serverEvent({ type: "deadline_warning", elapsedMs: event.elapsedMs }));
              break;

            case "not_covered":
              finished = true;
              flushText();
              commitRefusal(event.notCovered);
              break;

            case "complete":
              finished = true;
              flushText();
              commitAnswer(event.answer, event.durationMs);
              break;

            case "error":
              finished = true;
              flushText();
              dispatch(chatActions.serverEvent({ type: "error", code: event.code, message: event.message }));
              break;
          }
        }

        // The connection closed without a verdict: a dropped stream, not an answer.
        if (!finished && !ctrl.signal.aborted) {
          dispatch(chatActions.serverEvent({ type: "error", code: "stream_ended", message: "The connection dropped." }));
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        logger.error("[chat stream] failed", err);
        dispatch(
          chatActions.serverEvent({
            type: "error",
            code: err instanceof ApiError ? err.code : "network_error",
            message: err instanceof Error ? err.message : "The connection dropped.",
          }),
        );
      } finally {
        window.clearTimeout(slowTimer);
        if (frame) cancelAnimationFrame(frame);
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
