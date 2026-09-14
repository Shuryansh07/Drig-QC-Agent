import type { ConflictInfo } from "@/types/contracts";
import { Button } from "@/components/ui/button";
import { CitationChip } from "@/features/chat/components/CitationChip";

interface ConflictCardProps {
  conflict: ConflictInfo;
  onOpenCitation: (chunkId: string) => void;
  onRequestEngineer: () => void;
}

/**
 * Two sources, shown side by side, neither chosen (§5). Picking one would be the
 * system inventing a resolution it has no grounds for. Stacked on a phone,
 * paired on a wider screen — the comparison is the whole point.
 */
export function ConflictCard({
  conflict,
  onOpenCitation,
  onRequestEngineer,
}: ConflictCardProps) {
  return (
    <section className="border-neutral-note-border bg-neutral-note-bg rounded-xl border p-5">
      <p className="text-step text-answer-fg">
        Two sources disagree on this. I'm not going to guess which is right.
      </p>
      <p className="text-body text-muted-foreground mt-2">{conflict.question}</p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {conflict.sources.map((source) => (
          <article
            key={source.citation.chunkId}
            className="border-border bg-background rounded-lg border p-4"
          >
            <p className="text-body text-answer-fg">{source.claim}</p>
            <div className="mt-3">
              <CitationChip citation={source.citation} onOpen={onOpenCitation} />
            </div>
          </article>
        ))}
      </div>

      <Button onClick={onRequestEngineer} className="mt-6 h-touch-lg w-full text-step">
        Ask an engineer to settle it
      </Button>
    </section>
  );
}
