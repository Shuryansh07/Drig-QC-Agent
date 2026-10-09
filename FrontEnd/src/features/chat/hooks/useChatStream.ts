import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch } from "@/app/hooks";
import { chatActions } from "@/features/chat/chatSlice";
import { outboxActions } from "@/features/outbox/outboxSlice";
import { parseWireEvent, type WireImage, type WireSource } from "@/features/chat/streamEvents";
import { apiUrl, authHeaders, ApiError } from "@/lib/api-client";
import { readSSEFrames } from "@/lib/sse";
import { queryKeys } from "@/lib/query-client";
import { isOnline } from "@/lib/offline";
import { logger } from "@/lib/logger";
import { uuid } from "@/lib/uuid";
import type { AnswerImage, AnswerStep, Citation, ClarifyRequest, Conversation, NotCoveredInfo, Turn } from "@/types/contracts";
// import { uuid } from "@/lib/uuid";

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

export const toCitations = (sources: WireSource[]): Citation[] =>
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

export const toImages = (images: WireImage[]): AnswerImage[] =>
  images.map((i) => ({ label: i.label, url: i.url, page: i.page, documentId: i.document_id }));

const agentTurn = (overrides: Partial<Turn>): Turn => ({
  turnId: uuid(),
  role: "agent",
  text: "",
  steps: [],
  citations: [],
  images: [],
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
/** How many earlier turns travel with a question, so follow-ups are understood (the server trims it again). */
const CONTEXT_TURNS = 6;

/**
 * The conversation so far as the server wants it: the technician's questions and
 * the answers they got, oldest first. Refusals and clarification prompts are left
 * out: they say nothing about the topic.
 */
const contextTurns = (turns: Turn[]): { role: "technician" | "agent"; text: string }[] =>
  turns
    .filter((t) => t.text.trim() && (t.role === "technician" || t.gateOutcome === "answered"))
    .slice(-CONTEXT_TURNS)
    .map((t) => ({ role: t.role, text: t.text }));

/** The technician's answer to a clarification: re-asks the original question with their pick. */
export interface ClarificationAnswer {
  originalQuestion: string;
  value: string;
  skipped: boolean;
}

export function useChatStream(sessionId: string) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string, options?: { clarification?: ClarificationAnswer }) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!isOnline()) {
        // §9: queued, persisted, sent on reconnect. No spinner, no failure toast.
        dispatch(outboxActions.queued({ sessionId, text: trimmed }));
        return;
      }

      // Read before this question is added, so it is not sent as its own context. When answering a
      // clarification, the exchange that raised it (question, prompt, pick) is left out too:
      // the server already gets the original question and the pick.
      const earlier = queryClient.getQueryData<Conversation>(queryKeys.conversation(sessionId))?.turns ?? [];
      const askedAt = options?.clarification
        ? earlier.map((t) => t.role === "technician" && t.text === options.clarification!.originalQuestion).lastIndexOf(true)
        : earlier.length;
      const history = contextTurns(earlier.slice(0, askedAt < 0 ? earlier.length : askedAt));

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // The server saves the chat; these ids are what it saves the turns under, so a later "resolved" can name the answer.
      const technicianTurnId = uuid();
      const agentTurnId = uuid();

      appendTurn(queryClient, sessionId, {
        turnId: technicianTurnId,
        role: "technician",
        text: trimmed,
        steps: [],
        citations: [],
        images: [],
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
      let images: AnswerImage[] = [];
      let finished = false;

      const commitAnswer = (answer: string, durationMs: number, verified: boolean) => {
        const step: AnswerStep = { n: 1, text: answer, sourceChunkIds: citations.map((c) => c.chunkId) };
        const turn = agentTurn({ turnId: agentTurnId, text: answer, steps: [step], citations, images, gateOutcome: "answered", durationMs, verified });
        dispatch(chatActions.serverEvent({ type: "done", turn }));
        appendTurn(queryClient, sessionId, turn);
        dispatch(chatActions.clearStream());
      };

      const commitRefusal = (notCovered: NotCoveredInfo) => {
        // No durationMs: "Answered in Xms" under a refusal would be false.
        const turn = agentTurn({ turnId: agentTurnId, text: notCovered.message, gateOutcome: "not_covered", notCovered });
        dispatch(chatActions.serverEvent({ type: "not_covered", notCovered }));
        dispatch(chatActions.serverEvent({ type: "done", turn }));
        appendTurn(queryClient, sessionId, turn);
        dispatch(chatActions.clearStream());
      };

      const commitClarify = (clarify: ClarifyRequest) => {
        const turn = agentTurn({ turnId: agentTurnId, text: clarify.question, gateOutcome: "clarify", clarify });
        dispatch(chatActions.serverEvent({ type: "clarify", clarify }));
        dispatch(chatActions.serverEvent({ type: "done", turn }));
        appendTurn(queryClient, sessionId, turn);
        dispatch(chatActions.clearStream());
      };

      const clarification = options?.clarification;

      try {
        const response = await fetch(apiUrl("/rag/query/stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(await authHeaders()) },
          body: JSON.stringify(
            clarification
              ? {
                  customer_id: CUSTOMER_ID,
                  question: clarification.originalQuestion,
                  clarification: { value: clarification.value, skipped: clarification.skipped },
                  history,
                  session_id: sessionId,
                  turn_id: technicianTurnId,
                  agent_turn_id: agentTurnId,
                  display_text: trimmed,
                }
              : { customer_id: CUSTOMER_ID, question: trimmed, history, session_id: sessionId, turn_id: technicianTurnId, agent_turn_id: agentTurnId },
          ),
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

            case "images":
              images = toImages(event.images);
              dispatch(chatActions.serverEvent({ type: "images", images }));
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

            case "clarify":
              finished = true;
              flushText();
              commitClarify(event.clarify);
              break;

            case "complete":
              finished = true;
              flushText();
              commitAnswer(event.answer, event.durationMs, event.verified);
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
