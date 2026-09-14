import type { Resolution } from "@/types/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ResolutionBarProps {
  value: Resolution | null;
  onChange: (value: Resolution) => void;
}

const OPTIONS: Array<{ value: Resolution; label: string }> = [
  { value: "resolved", label: "Fixed it" },
  { value: "partly", label: "Partly" },
  { value: "not_resolved", label: "No" },
];

/** One tap, at the end of every turn. This is the outcome signal the whole
 *  evaluation loop is built on, so it must never take more than one tap. */
export function ResolutionBar({ value, onChange }: ResolutionBarProps) {
  return (
    <div className="space-y-3">
      <p className="text-body font-medium">Did that sort it?</p>
      <div role="group" aria-label="Did that sort it?" className="grid grid-cols-3 gap-2">
        {OPTIONS.map((option) => (
          <Button
            key={option.value}
            variant={value === option.value ? "default" : "outline"}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn("h-touch text-body", value === option.value && "font-semibold")}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
