import type { ClarifyRequest } from "@/types/contracts";
import { Button } from "@/components/ui/button";

interface ClarifyPromptProps {
  clarify: ClarifyRequest;
  onAnswer: (value: string) => void;
  onSkip: () => void;
}

/**
 * A first-class state, not an error (§5). One question, large options drawn from
 * the values retrieval actually found to distinguish. Styled like any other part
 * of the conversation — nothing here is a failure.
 */
export function ClarifyPrompt({ clarify, onAnswer, onSkip }: ClarifyPromptProps) {
  return (
    <section
      aria-labelledby={`clarify-${clarify.slot}`}
      className="border-neutral-note-border bg-neutral-note-bg rounded-2xl border p-4 sm:p-5"
    >
      <h2 id={`clarify-${clarify.slot}`} className="text-step font-semibold text-balance">
        {clarify.question}
      </h2>

      <div className="mt-5 grid gap-3">
        {clarify.options.map((option) => (
          <Button
            key={option.value}
            variant="outline"
            onClick={() => onAnswer(option.value)}
            className="bg-background h-auto min-h-14 justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
          >
            <span className="flex flex-col items-start gap-1">
              <span className="text-body font-medium">{option.label}</span>
              {option.hint ? (
                <span className="text-micro text-muted-foreground font-normal">
                  {option.hint}
                </span>
              ) : null}
            </span>
          </Button>
        ))}
      </div>

      {clarify.allowSkip ? (
        <Button
          variant="ghost"
          onClick={onSkip}
          className="text-muted-foreground mt-3 h-11 rounded-full text-base"
        >
          I don't know
        </Button>
      ) : null}
    </section>
  );
}
