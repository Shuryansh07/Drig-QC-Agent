import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { isInFlight, type AdminDocument, type DocumentListResponse } from "../types";

/**
 * GET /api/documents. Polls every couple of seconds while any document is
 * still being processed, and stops when everything has settled (an upload or
 * retry invalidates it again, which restarts the polling).
 */
export function useAdminDocuments() {
  return useQuery({
    queryKey: queryKeys.adminDocuments(),
    queryFn: async (): Promise<AdminDocument[]> => (await apiFetch<DocumentListResponse>("/documents")).documents,
    refetchInterval: (query) => (query.state.data?.some((d) => isInFlight(d.status)) ? 2000 : false),
    // Always show fresh progress when returning to the panel.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
