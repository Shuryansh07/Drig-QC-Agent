import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { logger } from "@/lib/logger";
import type { RagQueryRequest, RagQueryResponse } from "../types";

export interface RagQueryResult extends RagQueryResponse {
  /** Wall-clock time (ms) from request sent to answer received. */
  durationMs: number;
}

/** POSTs straight to the real backend: POST /api/rag/query -> { answer, sources }. */
export function useRagQuery() {
  return useMutation({
    mutationFn: async (input: RagQueryRequest): Promise<RagQueryResult> => {
      logger.info(`[rag search] question: "${input.question}" (customer: ${input.customer_id ?? "default"})`);

      const start = performance.now();
      const result = await apiFetch<RagQueryResponse>("/rag/query", {
        method: "POST",
        body: JSON.stringify(input),
      });
      const durationMs = Math.round(performance.now() - start);

      logger.info(
        `[rag search] answer received in ${durationMs}ms (${result.sources.length} source(s): ${result.sources
          .map((s) => `p.${s.page_number}`)
          .join(", ") || "none"})`,
      );

      return { ...result, durationMs };
    },
    onError: (err) => logger.error("[rag search] query failed", err),
  });
}
