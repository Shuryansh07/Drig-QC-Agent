import { useAppSelector } from "@/app/hooks";
import { AnswerSteps } from "@/features/chat/components/AnswerSteps";
import { AnswerImages } from "@/features/chat/components/AnswerImages";
import { AssistantMessage } from "@/features/chat/components/AssistantMessage";
import { ClarifyPrompt } from "@/features/chat/components/ClarifyPrompt";
import { NotCoveredCard } from "@/features/chat/components/NotCoveredCard";
import { ConflictCard } from "@/features/chat/components/ConflictCard";
import { DeadlineNotice } from "@/features/chat/components/DeadlineNotice";
import type { AnswerStep } from "@/types/contracts";

interface StreamingTurnViewProps {
  onOpenCitation: (chunkId: string) => void;
  onAnswerClarify: (value: string) => void;
  onSkipClarify: () => void;
  onRequestEngineer: () => void;
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
    <AssistantMessage>
      {stream.recentCorrections.map((correction) => (
        <p key={correction.field} role="status" className="text-muted-foreground text-sm">
          Switching to {String(correction.to)}
        </p>
      ))}

      {waiting ? (
        <div className="space-y-2" aria-label="Working on it">
          <div role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-3 py-1">
            <span className="flex items-center gap-1" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="bg-muted-foreground size-2 rounded-full motion-safe:animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
            <p className="text-base">{STAGE_LABEL[stream.stage ?? "retrieving"]}</p>
          </div>

          {stream.slow && !stream.deadlineWarning ? (
            <p className="text-muted-foreground text-sm">This is taking longer than usual. Still working on it.</p>
          ) : null}
        </div>
      ) : null}

      {stream.clarify ? (
        <ClarifyPrompt clarify={stream.clarify} onAnswer={onAnswerClarify} onSkip={onSkipClarify} />
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

      {/* Same gate as `steps` below: an answer that gets retracted never shows the
          evidence it was (wrongly) grounded on either — nothing orphaned on screen. */}
      {!stream.error ? <AnswerImages images={stream.images} /> : null}

      {steps.length > 0 ? (
        <AnswerSteps
          steps={steps}
          citations={stream.citations}
          streaming={stream.status === "streaming"}
          onOpenCitation={onOpenCitation}
        />
      ) : null}

      {stream.deadlineWarning && stream.status !== "done" ? (
        <DeadlineNotice onRequestEngineer={onRequestEngineer} />
      ) : null}

      {stream.error ? (
        <div role="alert" className="border-warn-border bg-warn-bg text-warn-fg rounded-2xl border p-4">
          <p className="text-body font-medium">That answer didn't come through.</p>
          <p className="text-body mt-1">Ask again, or get an engineer.</p>
        </div>
      ) : null}
    </AssistantMessage>
  );
}
