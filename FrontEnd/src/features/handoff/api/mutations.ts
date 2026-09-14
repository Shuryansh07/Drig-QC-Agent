import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { Handoff } from "@/types/contracts";

/**
 * The frame and full history transfer with the handoff (BACKEND_MEMORY.md §8),
 * so the technician never repeats themselves to the engineer.
 */
export function useOpenHandoff(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { note: string }) =>
      apiFetch<Handoff>("/handoffs", {
        method: "POST",
        body: JSON.stringify({ sessionId, note: input.note }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.handoffQueue() }),
  });
}
