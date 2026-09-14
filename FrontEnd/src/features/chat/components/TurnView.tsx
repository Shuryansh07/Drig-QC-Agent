import type { Resolution, Turn } from "@/types/contracts";
import { AnswerSteps } from "@/features/chat/components/AnswerSteps";
import { ClarifyPrompt } from "@/features/chat/components/ClarifyPrompt";
import { NotCoveredCard } from "@/features/chat/components/NotCoveredCard";
import { ConflictCard } from "@/features/chat/components/ConflictCard";
import { ResolutionBar } from "@/features/chat/components/ResolutionBar";

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
      <p className="text-body text-muted-foreground border-border border-l-2 py-1 pl-4">
        {turn.text}
      </p>
    );
  }

  return (
    <article className="space-y-6">
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

      {turn.gateOutcome === "answered" ? (
        <ResolutionBar value={turn.resolution} onChange={onResolution} />
      ) : null}
    </article>
  );
}
