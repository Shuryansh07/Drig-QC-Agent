import type { KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { PushToTalkButton } from "@/features/voice/components/PushToTalkButton";

interface ChatComposerProps {
  value: string;
  /** An answer is being generated: the send button becomes a stop button. */
  busy?: boolean;
  offline?: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}

/**
 * A rounded input card: text on top, voice on the left of the bottom row and send
 * on the right. Enter sends, Shift+Enter adds a line.
 */
export function ChatComposer({ value, busy, offline, onChange, onSend, onStop }: ChatComposerProps) {
  const canSend = value.trim().length > 0 && !busy;

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div className="space-y-2">
      <div className="bg-secondary focus-within:ring-ring/40 rounded-[1.75rem] border p-2 shadow-sm transition-shadow focus-within:ring-2 dark:bg-card">
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={offline ? "Type it now, it sends when you reconnect" : "Ask about an install, a wire, a fault…"}
          rows={1}
          aria-label="Your question"
          className="text-body max-h-48 min-h-0 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent"
        />

        <div className="flex items-center justify-between gap-2 pt-1">
          <PushToTalkButton disabled={busy} />

          {busy ? (
            <Button
              size="icon"
              aria-label="Stop generating"
              onClick={onStop}
              className="size-10 shrink-0 rounded-full"
            >
              <Square className="size-4 fill-current" aria-hidden />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label="Send question"
              disabled={!canSend}
              onClick={onSend}
              className="size-10 shrink-0 rounded-full"
            >
              <ArrowUp className="size-5" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      <p className="text-muted-foreground px-2 text-center text-sm">
        Answers come from the uploaded manuals. Double-check safety-critical steps.
      </p>
    </div>
  );
}
