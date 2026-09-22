import { FileText, Phone, Table2 } from "lucide-react";
import type { Citation } from "@/types/contracts";
import { cn } from "@/lib/utils";

const ICONS = {
  document: FileText,
  sheet_row: Table2,
  call: Phone,
} as const;

interface CitationChipProps {
  citation: Citation;
  /** Offline and not yet cached: still shown, but it cannot open (§9). */
  unavailable?: boolean;
  onOpen: (chunkId: string) => void;
}

/**
 * The tap target that opens the source drawer. Full 56px height even though the
 * chip reads as small — a technician in gloves gets the same target as a button.
 */
export function CitationChip({ citation, unavailable, onOpen }: CitationChipProps) {
  const Icon = ICONS[citation.kind];

  return (
    <button
      type="button"
      disabled={unavailable}
      onClick={() => onOpen(citation.chunkId)}
      className={cn(
        "inline-flex min-h-touch max-w-full items-center gap-2 rounded-lg px-3.5 py-2 text-left",
        "text-micro font-medium transition-colors",
        unavailable
          ? "bg-muted text-muted-foreground cursor-not-allowed"
          : "bg-citation-bg text-citation-fg active:brightness-95",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        {citation.label}
        <span className="opacity-70"> {citation.locator}</span>
      </span>
      {unavailable ? (
        <span className="sr-only">Available when back online</span>
      ) : null}
    </button>
  );
}
