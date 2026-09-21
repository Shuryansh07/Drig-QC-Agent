/**
 * PROVISIONAL. Delete this file once `/contracts` exists and
 * `src/types/generated/` is being produced from the shared JSON Schemas.
 *
 * Shapes here mirror `Plan/FRONTEND_DESIGN.md` §4 and `Plan/BACKEND_MEMORY.md`
 * §3. They are the minimum needed for the skeleton to typecheck.
 */

/* -------------------------------------------------------------------------- */
/* Session frame — BACKEND_MEMORY.md §3                                        */
/* -------------------------------------------------------------------------- */

export type StartType = "pts" | "key";

export interface QueryFrame {
  sessionId: string;
  orgId: string;
  workflowId: string;

  make: string | null;
  model: string | null;
  year: number | null;
  startType: StartType | null;
  vehicleConfidence: number;

  product: string | null;
  symptom: string | null;
  errorCode: string | null;
  installStage: string | null;
  circuit: string | null;

  alreadyTried: string[];
  askedSlots: string[];
  declinedSlots: string[];
  refusedTopics: string[];

  version: number;
  updatedAt: string;
}

/** Surfaced in the UI so the technician sees the system tracked a correction. */
export interface FrameCorrection {
  field: keyof QueryFrame & string;
  from: string | number | null;
  to: string | number | null;
}

/* -------------------------------------------------------------------------- */
/* Citations                                                                   */
/* -------------------------------------------------------------------------- */

export type CitationKind = "document" | "sheet_row" | "call";

export interface Citation {
  chunkId: string;
  kind: CitationKind;
  /** Document name, sheet name, or the caller's name. */
  label: string;
  /** Page for a document, row number for a sheet, timestamp for a call. */
  locator: string;
  /** The literal excerpt the gate matched against. Cached for offline reading. */
  excerpt?: string;
  documentId?: string;
  audioUrl?: string;
}

/* -------------------------------------------------------------------------- */
/* Answers                                                                     */
/* -------------------------------------------------------------------------- */

export interface AnswerStep {
  n: number;
  text: string;
  sourceChunkIds: string[];
  /** Renders in safety colours. The only place red is permitted. */
  isSafetyStep?: boolean;
}

export type GateOutcome = "answered" | "clarify" | "not_covered" | "conflict";

export type Resolution = "resolved" | "partly" | "not_resolved";

export interface ClarifyOption {
  value: string;
  label: string;
  /** Why this option is distinguishable — drawn from actual retrieval values. */
  hint?: string;
}

export interface ClarifyRequest {
  slot: string;
  question: string;
  options: ClarifyOption[];
  allowSkip: boolean;
}

export interface NotCoveredInfo {
  /** What *is* covered, so the technician learns the boundary. */
  coveredTopics: string[];
  message: string;
}

export interface ConflictSource {
  citation: Citation;
  claim: string;
}

export interface ConflictInfo {
  question: string;
  sources: [ConflictSource, ConflictSource];
}

export interface Turn {
  turnId: string;
  role: "technician" | "agent";
  text: string;
  steps: AnswerStep[];
  citations: Citation[];
  gateOutcome: GateOutcome | null;
  clarify: ClarifyRequest | null;
  notCovered: NotCoveredInfo | null;
  conflict: ConflictInfo | null;
  resolution: Resolution | null;
  createdAt: string;
  /** Wall-clock time (ms) from request sent to answer received. Agent turns only. */
  durationMs?: number;
}

export interface Conversation {
  sessionId: string;
  turns: Turn[];
  frame: QueryFrame | null;
}

/* -------------------------------------------------------------------------- */
/* Server-sent events — FRONTEND_DESIGN.md §4                                  */
/* -------------------------------------------------------------------------- */

export type ServerEvent =
  | { type: "frame"; frame: QueryFrame; corrections: FrameCorrection[] }
  | { type: "clarify"; clarify: ClarifyRequest }
  | { type: "step"; step: AnswerStep }
  | { type: "citation"; citation: Citation }
  | { type: "not_covered"; notCovered: NotCoveredInfo }
  | { type: "conflict"; conflict: ConflictInfo }
  | { type: "deadline_warning"; elapsedMs: number }
  | { type: "done"; turn: Turn }
  | { type: "error"; code: string; message: string };

export type ServerEventType = ServerEvent["type"];

/* -------------------------------------------------------------------------- */
/* Handoff and engineer queue                                                  */
/* -------------------------------------------------------------------------- */

export type HandoffStatus = "open" | "claimed" | "answered" | "closed";

export interface Handoff {
  handoffId: string;
  sessionId: string;
  status: HandoffStatus;
  technicianName: string;
  summary: string;
  frame: QueryFrame | null;
  openedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Vehicle resolution                                                          */
/* -------------------------------------------------------------------------- */

export interface VehicleMatch {
  make: string;
  model: string;
  year: number;
  startType: StartType | null;
  confidence: number;
  /** Alias the technician typed, when it differed from the canonical name. */
  matchedAlias?: string;
}

export interface RecentVehicle {
  make: string;
  model: string;
  year: number;
  lastSeenAt: string;
}
