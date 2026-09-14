import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  /** An empty screen is an invitation to act — say what to do, not what is missing. */
  body: string;
  action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-start gap-4 py-10">
      <h2 className="text-lead font-semibold tracking-tight text-balance">{title}</h2>
      <p className="text-body text-muted-foreground max-w-[38ch]">{body}</p>
      {action}
    </div>
  );
}
