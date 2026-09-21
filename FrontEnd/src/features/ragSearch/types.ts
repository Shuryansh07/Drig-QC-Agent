/**
 * Matches the actual backend contract (BackEnd/src/controllers/rag.controller.js),
 * not the elaborate session-frame/SSE contract in src/types/contracts.ts — that
 * one describes a future system with no backend behind it yet. This one is real.
 */

export interface RagQuerySource {
  document_id: string;
  page_number: number;
}

export interface RagQueryResponse {
  answer: string;
  sources: RagQuerySource[];
}

export interface RagQueryRequest {
  customer_id?: string;
  question: string;
}
