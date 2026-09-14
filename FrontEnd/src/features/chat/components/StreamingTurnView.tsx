import { useAppSelector } from "@/app/hooks";
import { AnswerSteps } from "@/features/chat/components/AnswerSteps";
import { ClarifyPrompt } from "@/features/chat/components/ClarifyPrompt";
import { NotCoveredCard } from "@/features/chat/components/NotCoveredCard";
import { ConflictCard } from "@/features/chat/components/ConflictCard";
import { DeadlineNotice } from "@/features/chat/components/DeadlineNotice";
import { Skeleton } from "@/components/ui/skeleton";

interface StreamingTurnViewProps {
  onOpenCitation: (chunkId: string) => void;
  onAnswerClarify: (value: string) => void;
  onSkipClarify: () => void;
  onRequestEngineer: () => void;
}

/** The in-flight buffer, rendered. Cleared the moment `done` commits the turn
 *  into the query cache, so this never coexists with its finished counterpart. */
export function StreamingTurnView({
  onOpenCitation,
  onAnswerClarify,
  onSkipClarify,
  onRequestEngineer,
}: StreamingTurnViewProps) {
  const stream = useAppSelector((s) => s.chat);

  if (stream.status === "idle") return null;

  return (
    <div className="space-y-6">
      {stream.recentCorrections.map((correction) => (
        <p
          key={correction.field}
          role="status"
          className="text-micro text-muted-foreground"
        >
          Switching to {String(correction.to)}
        </p>
      ))}

      {stream.status === "thinking" && stream.steps.length === 0 ? (
        <div className="space-y-3" aria-label="Working on it">
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-6 w-3/5" />
        </div>
      ) : null}

      {stream.clarify ? (
        <ClarifyPrompt
          clarify={stream.clarify}
          onAnswer={onAnswerClarify}
          onSkip={onSkipClarify}
        />
      ) : null}

      {stream.notCovered ? (
        <NotCoveredCard info={stream.notCovered} onRequestEngineer={onRequestEngineer} />
      ) : null}

      {stream.conflict ? (
        <ConflictCard
          conflict={stream.conflict}
          onOpenCitation={onOpenCitation}
          onRequestEngineer={onRequestEngineer}
        />
      ) : null}

      {stream.steps.length > 0 ? (
        <AnswerSteps
          steps={stream.steps}
          citations={stream.citations}
          streaming={stream.status === "streaming"}
          onOpenCitation={onOpenCitation}
        />
      ) : null}

      {stream.deadlineWarning && stream.status !== "done" ? (
        <DeadlineNotice onRequestEngineer={onRequestEngineer} />
      ) : null}

      {stream.error ? (
        <div
          role="alert"
          className="border-warn-border bg-warn-bg text-warn-fg rounded-xl border p-5"
        >
          <p className="text-body font-medium">That answer didn't come through.</p>
          <p className="text-body mt-1">Ask again, or get an engineer.</p>
        </div>
      ) : null}
    </div>
  );
}
