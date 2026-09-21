import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { Conversation } from "@/types/contracts";

/**
 * GET /conversations/:id doesn't exist on the real backend — it has no
 * conversation-history endpoint at all, just one-shot POST /rag/query. So
 * this query never actually fetches (`enabled: false`); it only exists to
 * subscribe to the cache entry that useChatStream seeds directly via
 * queryClient.setQueryData after each real response. That's the actual
 * source of truth for turn history now, kept in-memory per session.
 */
export function useConversation(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.conversation(sessionId ?? "none"),
    enabled: false,
    queryFn: () => apiFetch<Conversation>(`/conversations/${sessionId}`),
  });
}
