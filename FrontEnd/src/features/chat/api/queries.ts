import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { toCitations, toImages } from "@/features/chat/hooks/useChatStream";
import type { WireImage, WireSource } from "@/features/chat/streamEvents";
import type { ClarifyRequest, Conversation, NotCoveredInfo, Resolution, Turn } from "@/types/contracts";

/** A saved turn as GET /api/conversations/:sessionId returns it (BackEnd/src/controllers/conversation.controller.js). */
interface WireTurn {
  turn_id: string;
  role: "technician" | "agent";
  text: string;
  gate_outcome: "answered" | "clarify" | "not_covered" | "conflict" | null;
  resolution: Resolution | null;
  created_at: string;
  sources: WireSource[];
  images: WireImage[];
  clarify: ClarifyRequest | null;
  not_covered: NotCoveredInfo | null;
  verified: boolean | null;
  duration_ms: number | null;
}

const toTurn = (t: WireTurn): Turn => {
  const citations = toCitations(t.sources ?? []);
  const answered = t.role === "agent" && t.gate_outcome === "answered";
  return {
    turnId: t.turn_id,
    role: t.role,
    text: t.text,
    steps: answered ? [{ n: 1, text: t.text, sourceChunkIds: citations.map((c) => c.chunkId) }] : [],
    citations: t.role === "agent" ? citations : [],
    images: t.role === "agent" ? toImages(t.images ?? []) : [],
    gateOutcome: t.role === "agent" ? t.gate_outcome : null,
    clarify: t.clarify,
    notCovered: t.not_covered,
    conflict: null,
    resolution: t.resolution,
    createdAt: t.created_at,
    ...(t.duration_ms !== null ? { durationMs: t.duration_ms } : {}),
    ...(t.verified !== null ? { verified: t.verified } : {}),
  };
};

/**
 * GET /api/conversations/:sessionId. The chat is saved in the database by the
 * server, as each turn happens; this reads it back, so a reload (the session id
 * is in the URL) or another device shows the same conversation. Nothing about the
 * chat is kept in the browser.
 *
 * While a conversation is open, useChatStream adds each new turn to this cache
 * straight away so it appears without a round trip; the server already has it.
 */
export function useConversation(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.conversation(sessionId ?? "none"),
    enabled: Boolean(sessionId),
    queryFn: async (): Promise<Conversation> => {
      const data = await apiFetch<{ turns: WireTurn[] }>(`/conversations/${sessionId}`);
      return { sessionId: sessionId!, turns: data.turns.map(toTurn), frame: null };
    },
    // The live cache is already correct once loaded: refetching would only replace it with the same thing.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
