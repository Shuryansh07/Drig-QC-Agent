import type {
  AnswerStep,
  Citation,
  ClarifyRequest,
  ConflictInfo,
  FrameCorrection,
  GateOutcome,
  NotCoveredInfo,
  QueryFrame,
} from "@/types/contracts";

export type StreamStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "validating"
  | "done"
  | "refused"
  | "error";

/**
 * The in-flight buffer (§3). A token stream is neither a query result nor pure
 * client state, so Redux holds it only while it is moving. On `done` the
 * finished turn is written into the TanStack cache and this is cleared.
 */
export interface StreamingTurn {
  turnId: string | null;
  status: StreamStatus;
  /** What the server is doing right now, so a wait has a name instead of a blank spinner. */
  stage: "retrieving" | "generating" | null;
  /** No answer text yet after several seconds: say so instead of looking frozen. */
  slow: boolean;
  steps: AnswerStep[];
  /** The answer as it arrives, before it is committed as a finished turn. */
  partialText: string;
  citations: Citation[];
  gateOutcome: GateOutcome | null;
  clarify: ClarifyRequest | null;
  notCovered: NotCoveredInfo | null;
  conflict: ConflictInfo | null;
  /** Fires at the 22s internal deadline, not at stream death. */
  deadlineWarning: boolean;
  error: { code: string; message: string } | null;
}

export interface ChatState extends StreamingTurn {
  sessionId: string | null;
  draft: string;
  frame: QueryFrame | null;
  /** "Switching to 2021" — shown so the technician sees the system kept up. */
  recentCorrections: FrameCorrection[];
}
