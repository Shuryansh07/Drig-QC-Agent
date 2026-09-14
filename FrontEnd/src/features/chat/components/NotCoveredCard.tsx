import type { NotCoveredInfo } from "@/types/contracts";
import { Button } from "@/components/ui/button";

interface NotCoveredCardProps {
  info: NotCoveredInfo;
  onRequestEngineer: () => void;
}

/**
 * Neutral styling, never red (§5). If "I don't have that documented" reads as a
 * fault, technicians read the product as broken and stop using it — the exact
 * outcome the gates exist to avoid. Lead with what *is* covered so the boundary
 * becomes learnable.
 */
export function NotCoveredCard({ info, onRequestEngineer }: NotCoveredCardProps) {
  return (
    <section className="border-neutral-note-border bg-neutral-note-bg rounded-xl border p-5">
      <p className="text-step text-answer-fg">{info.message}</p>

      {info.coveredTopics.length > 0 ? (
        <div className="mt-5">
          <p className="text-body font-semibold">What I do have for this vehicle</p>
          <ul className="text-body text-muted-foreground mt-2 space-y-1.5">
            {info.coveredTopics.map((topic) => (
              <li key={topic} className="before:mr-2 before:content-['—']">
                {topic}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Button
        onClick={onRequestEngineer}
        className="mt-6 h-touch-lg w-full text-step"
      >
        Ask an engineer
      </Button>
    </section>
  );
}
