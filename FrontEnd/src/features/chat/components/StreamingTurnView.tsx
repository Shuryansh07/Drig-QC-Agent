import { LoaderCircle } from "lucide-react";
import { useAppSelector } from "@/app/hooks";
import { AnswerSteps } from "@/features/chat/components/AnswerSteps";
import { ClarifyPrompt } from "@/features/chat/components/ClarifyPrompt";
import { NotCoveredCard } from "@/features/chat/components/NotCoveredCard";
import { ConflictCard } from "@/features/chat/components/ConflictCard";
import { DeadlineNotice } from "@/features/chat/components/DeadlineNotice";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnswerStep } from "@/types/contracts";

interface StreamingTurnViewProps {
  onOpenCitation: (chunkId: string) => void;
  onAnswerClarify: (value: string) => void;
  onSkipClarify: () => void;
  onRequestEngineer: () => void;
  onCancel: () => void;
}

const STAGE_LABEL = {
  retrieving: "Searching the manuals…",
  generating: "Writing the answer…",
} as const;

/** The in-flight buffer, rendered. Cleared the moment `done` commits the turn
 *  into the query cache, so this never coexists with its finished counterpart. */
export function StreamingTurnView({
  onOpenCitation,
  onAnswerClarify,
  onSkipClarify,
  onRequestEngineer,
  onCancel,
}: StreamingTurnViewProps) {
  const stream = useAppSelector((s) => s.chat);

  if (stream.status === "idle") return null;

  const inFlight = stream.status === "thinking" || stream.status === "streaming";
  const hasText = stream.partialText.length > 0 || stream.steps.length > 0;
  // Nothing on screen yet to read: this is the wait that needs a name.
  const waiting = inFlight && !hasText;

  // Text that was mid-stream when something broke is unverified. Never leave it up.
  const steps: AnswerStep[] =
    stream.steps.length > 0
      ? stream.steps
      : stream.partialText && !stream.error
        ? [{ n: 1, text: stream.partialText, sourceChunkIds: stream.citations.map((c) => c.chunkId) }]
        : [];

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

      {waiting ? (
        <div className="space-y-4" aria-label="Working on it">
          <div role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-3">
            <LoaderCircle className="size-5 shrink-0 motion-safe:animate-spin" aria-hidden />
            <p className="text-body">{STAGE_LABEL[stream.stage ?? "retrieving"]}</p>
          </div>

          {stream.slow && !stream.deadlineWarning ? (
            <p className="text-micro text-muted-foreground">This is taking longer than usual. Still working on it.</p>
          ) : null}

          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-6 w-3/5" />
          </div>
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

      {steps.length > 0 ? (
        <AnswerSteps
          steps={steps}
          citations={stream.citations}
          streaming={stream.status === "streaming"}
          onOpenCitation={onOpenCitation}
        />
      ) : null}

      {inFlight ? (
        <Button variant="ghost" size="sm" onClick={onCancel} className="text-muted-foreground">
          Stop
        </Button>
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
