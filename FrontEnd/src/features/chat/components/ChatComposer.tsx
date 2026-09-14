import { SendHorizonal } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { PushToTalkButton } from "@/features/voice/components/PushToTalkButton";

interface ChatComposerProps {
  value: string;
  disabled?: boolean;
  offline?: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}

/**
 * Lives in the dock. Push-to-talk is the larger of the two targets because it is
 * the one a technician reaches for with a panel in the other hand.
 */
export function ChatComposer({
  value,
  disabled,
  offline,
  onChange,
  onSend,
}: ChatComposerProps) {
  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={offline ? "Type it now, it sends when you reconnect" : "What's the problem?"}
          rows={1}
          className="text-body max-h-40 min-h-touch resize-none py-3.5"
        />
        <Button
          size="icon"
          aria-label="Send question"
          disabled={!canSend}
          onClick={onSend}
          className="size-touch shrink-0"
        >
          <SendHorizonal className="size-5" aria-hidden />
        </Button>
      </div>

      <PushToTalkButton disabled={disabled} />
    </div>
  );
}
