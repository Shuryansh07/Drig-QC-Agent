import type { ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/** The assistant side of the conversation: a small avatar and a full-width column. */
export function AssistantMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 sm:gap-4">
      <Avatar className="mt-0.5 size-8 shrink-0">
        <AvatarFallback className="bg-foreground text-background text-sm font-semibold">D</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-4">{children}</div>
    </div>
  );
}
