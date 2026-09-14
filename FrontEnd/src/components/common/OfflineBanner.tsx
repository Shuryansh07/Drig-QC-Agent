import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useAppSelector } from "@/app/hooks";

/**
 * Cached-only mode (§9). Neutral, never alarming — losing signal in a workshop
 * is normal, and the app still works for reading answers already received.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  const queued = useAppSelector((s) => s.outbox.entries.length);

  if (online) return null;

  return (
    <div
      role="status"
      className="bg-offline-bg text-foreground border-border flex items-center gap-3 border-b px-5 py-3"
    >
      <WifiOff className="size-5 shrink-0" aria-hidden />
      <p className="text-micro font-medium">
        No signal. Answers you already have stay readable
        {queued > 0
          ? ` — ${queued} question${queued === 1 ? "" : "s"} will send when you reconnect.`
          : "."}
      </p>
    </div>
  );
}
