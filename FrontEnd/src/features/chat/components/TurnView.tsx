import type { Resolution, Turn } from "@/types/contracts";
import { AnswerSteps } from "@/features/chat/components/AnswerSteps";
import { ClarifyPrompt } from "@/features/chat/components/ClarifyPrompt";
import { NotCoveredCard } from "@/features/chat/components/NotCoveredCard";
import { ConflictCard } from "@/features/chat/components/ConflictCard";
import { ResolutionBar } from "@/features/chat/components/ResolutionBar";
import { AssistantMessage } from "@/features/chat/components/AssistantMessage";

interface TurnViewProps {
  turn: Turn;
  onOpenCitation: (chunkId: string) => void;
  onAnswerClarify: (value: string) => void;
  onSkipClarify: () => void;
  onRequestEngineer: () => void;
  onResolution: (value: Resolution) => void;
}

/** Renders whichever of the four gate outcomes this turn produced. */
export function TurnView({
  turn,
  onOpenCitation,
  onAnswerClarify,
  onSkipClarify,
  onRequestEngineer,
  onResolution,
}: TurnViewProps) {
  if (turn.role === "technician") {
    return (
      <div className="flex justify-end">
        <p className="bg-secondary text-foreground text-body max-w-[85%] rounded-3xl px-5 py-2.5 break-words whitespace-pre-wrap">
          {turn.text}
        </p>
      </div>
    );
  }

  return (
    <AssistantMessage>
      {turn.clarify ? (
        <ClarifyPrompt
          clarify={turn.clarify}
          onAnswer={onAnswerClarify}
          onSkip={onSkipClarify}
        />
      ) : null}

      {turn.notCovered ? (
        <NotCoveredCard info={turn.notCovered} onRequestEngineer={onRequestEngineer} />
      ) : null}

      {turn.conflict ? (
        <ConflictCard
          conflict={turn.conflict}
          onOpenCitation={onOpenCitation}
          onRequestEngineer={onRequestEngineer}
        />
      ) : null}

      {turn.steps.length > 0 ? (
        <AnswerSteps
          steps={turn.steps}
          citations={turn.citations}
          onOpenCitation={onOpenCitation}
        />
      ) : null}

      {turn.durationMs !== undefined ? (
        <p className="text-muted-foreground text-sm" role="status">
          Answered in {turn.durationMs}ms
        </p>
      ) : null}

      {turn.gateOutcome === "answered" ? (
        <ResolutionBar value={turn.resolution} onChange={onResolution} />
      ) : null}
    </AssistantMessage>
  );
}
