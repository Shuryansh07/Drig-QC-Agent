import { AlertTriangle } from "lucide-react";
import type { AnswerStep, Citation } from "@/types/contracts";
import { CitationChip } from "@/features/chat/components/CitationChip";
import { cn } from "@/lib/utils";

interface AnswerStepsProps {
  steps: AnswerStep[];
  citations: Citation[];
  /** True while tokens are still arriving, so the list is announced politely. */
  streaming?: boolean;
  onOpenCitation: (chunkId: string) => void;
  citationAvailable?: (chunkId: string) => boolean;
}

/**
 * The most important component in the app. Steps are a genuine sequence, so they
 * are numbered; the number is the anchor a technician looks back to after
 * putting the phone down to use both hands.
 */
export function AnswerSteps({
  steps,
  citations,
  streaming,
  onOpenCitation,
  citationAvailable,
}: AnswerStepsProps) {
  const byId = new Map(citations.map((c) => [c.chunkId, c]));

  return (
    <ol
      aria-live={streaming ? "polite" : undefined}
      aria-busy={streaming}
      className="space-y-7"
    >
      {steps.map((step) => {
        const cites = step.sourceChunkIds
          .map((id) => byId.get(id))
          .filter((c): c is Citation => Boolean(c));

        return (
          <li key={step.n} className="grid grid-cols-[2.25rem_1fr] gap-x-4">
            <span
              className={cn(
                "flex size-9 items-center justify-center rounded-lg text-step font-semibold tabular-nums",
                step.isSafetyStep
                  ? "bg-safety-bg text-safety-fg"
                  : "bg-secondary text-secondary-foreground",
              )}
              aria-hidden
            >
              {step.n}
            </span>

            <div className="space-y-3 pt-0.5">
              {step.isSafetyStep ? (
                <p className="text-safety-fg text-micro inline-flex items-center gap-2 font-semibold">
                  <AlertTriangle className="size-4" aria-hidden />
                  Safety step
                </p>
              ) : null}

              <p className="text-step text-answer-fg">
                <span className="sr-only">Step {step.n}. </span>
                {step.text}
              </p>

              {cites.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {cites.map((c) => (
                    <CitationChip
                      key={c.chunkId}
                      citation={c}
                      unavailable={citationAvailable ? !citationAvailable(c.chunkId) : false}
                      onOpen={onOpenCitation}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
