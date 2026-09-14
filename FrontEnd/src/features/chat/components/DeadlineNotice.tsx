import { Button } from "@/components/ui/button";

interface DeadlineNoticeProps {
  onRequestEngineer: () => void;
}

/**
 * Fires at the 22-second internal deadline (§4). The point is that the stream
 * says something rather than dying silently — a technician staring at a spinner
 * assumes the app is broken within about ten seconds.
 */
export function DeadlineNotice({ onRequestEngineer }: DeadlineNoticeProps) {
  return (
    <div
      role="status"
      className="border-warn-border bg-warn-bg text-warn-fg rounded-xl border p-5"
    >
      <p className="text-body font-medium">Still working on this one.</p>
      <Button
        variant="outline"
        onClick={onRequestEngineer}
        className="bg-background mt-4 h-touch w-full text-body"
      >
        Get an engineer instead
      </Button>
    </div>
  );
}
