import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import {
  isImportInFlight,
  isInFlight,
  type DocumentCollection,
  type DocumentListResponse,
  type DriveSyncStatus,
  type MissKind,
  type UnansweredListResponse,
  type WiringImport,
} from "../types";

export const DOCUMENTS_PAGE_SIZE = 10;

/**
 * GET /api/documents?page=&page_size=&q=&collection=. Polls every couple of seconds
 * while a document on the CURRENT page is still being processed, and stops
 * once everything on it has settled (an upload or retry invalidates every
 * page and search, which restarts polling on whatever's open). A document in
 * flight on a different page or search is still covered: it lands on page 1
 * (newest first) and that polling resumes as soon as the admin turns to it.
 *
 * `search` should already be debounced by the caller — this hook fires a
 * request on every value it's given. `collection` limits the list to the DRIG
 * Standard manuals or to the others.
 */
export function useAdminDocuments(page: number, search: string, collection?: DocumentCollection) {
  return useQuery({
    queryKey: queryKeys.adminDocuments(page, search, collection),
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), page_size: String(DOCUMENTS_PAGE_SIZE) });
      if (search) params.set("q", search);
      if (collection) params.set("collection", collection);
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
    refetchInterval: (query) => (query.state.data && (query.state.data.phase !== "idle" || query.state.data.pending_jobs > 0) ? 1500 : false),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** GET /api/wiring/imports. Polls every 2s while an import is queued or running (links, then photo reading). */
export function useWiringImports() {
  return useQuery({
    queryKey: queryKeys.wiringImports(),
    queryFn: () => apiFetch<{ imports: WiringImport[] }>("/wiring/imports"),
    refetchInterval: (query) => (query.state.data?.imports.some((i) => isImportInFlight(i.status)) ? 2000 : false),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export const UNANSWERED_PAGE_SIZE = 20;

/** GET /api/conversations/unanswered?page=&page_size=&q=&kind= — questions the assistant did not answer, newest first. */
export function useUnansweredQuestions(page: number, search: string, kind: MissKind | null) {
  return useQuery({
    queryKey: queryKeys.unanswered(page, search, kind ?? "all"),
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), page_size: String(UNANSWERED_PAGE_SIZE) });
      if (search) params.set("q", search);
      if (kind) params.set("kind", kind);
      return apiFetch<UnansweredListResponse>(`/conversations/unanswered?${params}`);
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
