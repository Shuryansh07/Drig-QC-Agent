import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { logger } from "@/lib/logger";
import type { DeleteResponse, DriveSyncStatus, RetryResponse, UploadResponse } from "../types";

/**
 * POST /api/documents/upload (multipart, field "file"). Returns as soon as the
 * file is accepted — parsing, chunking and embedding happen in the worker, and
 * the document list picks up progress by polling.
 */
export function useUploadDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File): Promise<UploadResponse> => {
      logger.info(`[admin upload] "${file.name}" (${file.size} bytes)`);
      const body = new FormData();
      body.append("file", file);
      return apiFetch<UploadResponse>("/documents/upload", { method: "POST", body });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminDocuments() }),
    onError: (err) => logger.error("[admin upload] failed", err),
  });
}

/**
 * POST /api/documents/sync-drive (import) or /sync-drive/scan (count only).
 * Both return at once with the new status; useDriveSyncStatus() polls from there.
 */
function useDriveSyncAction(path: string, label: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiFetch<DriveSyncStatus>(path, { method: "POST" }),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.driveSync(), status),
    onError: (err) => logger.error(`[admin drive ${label}] failed`, err),
  });
}

export const useSyncDrive = () => useDriveSyncAction("/documents/sync-drive", "sync");
export const useScanDrive = () => useDriveSyncAction("/documents/sync-drive/scan", "scan");
/** POST /api/documents/sync-drive/stop: stops the sync and cancels every job it already queued for the worker. */
export const useStopDriveSync = () => useDriveSyncAction("/documents/sync-drive/stop", "stop");

/** POST /api/documents/:id/retry. The worker skips vectors it already computed. */
export function useRetryDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (documentId: string) => apiFetch<RetryResponse>(`/documents/${documentId}/retry`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminDocuments() }),
    onError: (err) => logger.error("[admin retry] failed", err),
  });
}

/** DELETE /api/documents/:id. Removes the document, its chunks and vectors, and the stored files. */
export function useDeleteDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (documentId: string) => apiFetch<DeleteResponse>(`/documents/${documentId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminDocuments() }),
    onError: (err) => logger.error("[admin delete] failed", err),
  });
}
