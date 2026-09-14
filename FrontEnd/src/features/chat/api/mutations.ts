import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { Resolution } from "@/types/contracts";

export function useRecordResolution(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { turnId: string; resolution: Resolution }) =>
      apiFetch<void>(`/conversations/${sessionId}/turns/${input.turnId}/resolution`, {
        method: "POST",
        body: JSON.stringify({ resolution: input.resolution }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.conversation(sessionId) }),
  });
}
