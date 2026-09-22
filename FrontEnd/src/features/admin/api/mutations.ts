import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { logger } from "@/lib/logger";
import type { RetryResponse, UploadResponse } from "../types";

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

/** POST /api/documents/:id/retry. The worker skips vectors it already computed. */
export function useRetryDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (documentId: string) => apiFetch<RetryResponse>(`/documents/${documentId}/retry`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminDocuments() }),
    onError: (err) => logger.error("[admin retry] failed", err),
  });
}
