import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { Conversation } from "@/types/contracts";

export function useConversation(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.conversation(sessionId ?? "none"),
    enabled: Boolean(sessionId),
    queryFn: () => apiFetch<Conversation>(`/conversations/${sessionId}`),
  });
}
