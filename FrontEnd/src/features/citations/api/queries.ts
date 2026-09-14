import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { Citation } from "@/types/contracts";

export function useCitation(chunkId: string | null) {
  return useQuery({
    queryKey: queryKeys.citation(chunkId ?? "none"),
    enabled: Boolean(chunkId),
    // Document metadata changes rarely; a technician reopening the same source
    // three times in one job should not refetch it three times.
    staleTime: 60 * 60 * 1000,
    queryFn: () => apiFetch<Citation>(`/citations/${chunkId}`),
  });
}
