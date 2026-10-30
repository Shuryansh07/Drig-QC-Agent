import type { Turn } from "@/types/contracts";
import { withoutSourceRefs } from "@/features/chat/lib/procedure";

/**
 * What "Read aloud" says for a turn; empty when there is nothing to read.
 * A listener can't see the screen, so the step numbers, safety labels and the
 * "verify this" caution are spoken too, not just the answer text.
 */
export function speechTextFor(turn: Turn): string {
  if (turn.role !== "agent") return "";
  if (turn.notCovered) return turn.notCovered.message;
  if (turn.gateOutcome !== "answered") return "";

  const realSteps = turn.steps.filter((s) => s.kind !== "note");
  const numbered = realSteps.length > 1 || realSteps.some((s) => s.isSafetyStep);
  const parts = turn.steps.map((step) => {
    const number = numbered && step.kind !== "note" ? `Step ${step.n}. ` : "";
    const safety = step.isSafetyStep ? "Safety step. " : "";
    return `${number}${safety}${withoutSourceRefs(step.text)}`;
  });
  if (parts.length === 0 && turn.text) parts.push(withoutSourceRefs(turn.text));
  if (parts.length === 0) return "";

  if (turn.verified === false) parts.unshift("Please verify this information with the reference documents.");
  return parts.join("\n");
}
