import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { isInFlight, type DocumentListResponse, type DriveSyncStatus } from "../types";

export const DOCUMENTS_PAGE_SIZE = 10;

/**
 * GET /api/documents?page=&page_size=&q=. Polls every couple of seconds
 * while a document on the CURRENT page is still being processed, and stops
 * once everything on it has settled (an upload or retry invalidates every
 * page and search, which restarts polling on whatever's open). A document in
 * flight on a different page or search is still covered: it lands on page 1
 * (newest first) and that polling resumes as soon as the admin turns to it.
 *
 * `search` should already be debounced by the caller — this hook fires a
 * request on every value it's given.
 */
export function useAdminDocuments(page: number, search: string) {
  return useQuery({
    queryKey: queryKeys.adminDocuments(page, search),
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), page_size: String(DOCUMENTS_PAGE_SIZE) });
      if (search) params.set("q", search);
      return apiFetch<DocumentListResponse>(`/documents?${params}`);
    },
    refetchInterval: (query) => (query.state.data?.documents.some((d) => isInFlight(d.status)) ? 2000 : false),
    // Always show fresh progress when returning to the panel.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/**
 * GET /api/documents/sync-drive. Polls every 1.5s while a Drive scan or sync
 * is running, so the panel's progress moves; idle otherwise.
 */
export function useDriveSyncStatus() {
  return useQuery({
    queryKey: queryKeys.driveSync(),
    queryFn: () => apiFetch<DriveSyncStatus>("/documents/sync-drive"),
    refetchInterval: (query) => (query.state.data && query.state.data.phase !== "idle" ? 1500 : false),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
