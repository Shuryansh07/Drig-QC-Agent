import type { NotCoveredInfo } from "@/types/contracts";
import { parseSSEData } from "@/lib/sse";

/**
 * What POST /api/rag/query/stream sends (BackEnd/src/controllers/rag.controller.js).
 * Deliberately separate from ServerEvent in types/contracts.ts, which describes
 * the richer session-frame protocol of a backend that does not exist yet. The
 * chat hook translates these into the Redux events the UI already understands.
 */
export type WireStage = "retrieving" | "generating";

export interface WireSource {
  document_id: string;
  document_title?: string | null;
  /** Null for sources with no pages (Word documents), which are cited by section. */
  page_number: number | null;
  section_path: string | null;
}

export type WireEvent =
  | { type: "stage"; stage: WireStage }
  | { type: "sources"; sources: WireSource[] }
  | { type: "delta"; text: string }
  | { type: "not_covered"; notCovered: NotCoveredInfo }
  | { type: "deadline_warning"; elapsedMs: number }
  | { type: "complete"; answer: string; durationMs: number }
  | { type: "error"; code: string; message: string };

const TYPES = new Set(["stage", "sources", "delta", "not_covered", "deadline_warning", "complete", "error"]);

export function parseWireEvent(frame: string): WireEvent | null {
  const parsed = parseSSEData(frame);
  if (typeof parsed !== "object" || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" && TYPES.has(type) ? (parsed as WireEvent) : null;
}
