import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OfflineBanner } from "@/components/common/OfflineBanner";

interface PageShellProps {
  /** Sits above the scroll area. Keep it to one line — screen space is answer space. */
  header?: ReactNode;
  /** The thumb zone. Primary actions live here and nowhere else (§1). */
  dock?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * One column, full height, with a fixed dock in the bottom third. Every screen
 * uses this so the primary action is always in the same place under the thumb.
 */
export function PageShell({ header, dock, children, className }: PageShellProps) {
  return (
    <div className="bg-background flex h-dvh flex-col">
      <OfflineBanner />
      {header ? (
        <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/80 shrink-0 border-b backdrop-blur">
          {header}
        </header>
      ) : null}

      <main className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", className)}>
        <div className="mx-auto w-full max-w-[42rem] px-5 py-6">{children}</div>
      </main>

      {dock ? (
        <div className="border-border bg-background shrink-0 border-t">
          <div className="mx-auto w-full max-w-[42rem] px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {dock}
          </div>
        </div>
      ) : null}
    </div>
  );
}
