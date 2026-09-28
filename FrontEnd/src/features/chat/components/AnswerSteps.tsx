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
 * A single unnumbered step is just the answer, so it reads as plain text like a
 * chat reply. A genuine sequence of steps keeps its numbers: the number is the
 * anchor a technician looks back to after putting the phone down.
 */
export function AnswerSteps({
  steps,
  citations,
  streaming,
  onOpenCitation,
  citationAvailable,
}: AnswerStepsProps) {
  const byId = new Map(citations.map((c) => [c.chunkId, c]));
  const numbered = steps.length > 1 || steps.some((s) => s.isSafetyStep);

  return (
    <ol aria-live={streaming ? "polite" : undefined} aria-busy={streaming} className="space-y-6">
      {steps.map((step) => {
        const cites = step.sourceChunkIds
          .map((id) => byId.get(id))
          .filter((c): c is Citation => Boolean(c));

        return (
          // minmax(0,1fr), not 1fr: a long citation chip must shrink and truncate, not widen the column past the screen.
          <li
            key={step.n}
            className={cn(numbered && "grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3")}
          >
            {numbered ? (
              <span
                className={cn(
                  "flex size-8 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
                  step.isSafetyStep ? "bg-safety-bg text-safety-fg" : "bg-secondary text-secondary-foreground",
                )}
                aria-hidden
              >
                {step.n}
              </span>
            ) : null}

            <div className="min-w-0 space-y-3">
              {step.isSafetyStep ? (
                <p className="text-safety-fg inline-flex items-center gap-2 text-sm font-semibold">
                  <AlertTriangle className="size-4" aria-hidden />
                  Safety step
                </p>
              ) : null}

              <p className="text-body text-answer-fg break-words whitespace-pre-wrap">
                {numbered ? <span className="sr-only">Step {step.n}. </span> : null}
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
