import { Mic, Square } from "lucide-react";
import { useAppSelector } from "@/app/hooks";
import { useRecorder } from "@/features/voice/hooks/useRecorder";
import { Waveform } from "@/features/voice/components/Waveform";
import { cn } from "@/lib/utils";

interface PushToTalkButtonProps {
  disabled?: boolean;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A round mic button inside the composer. Hold to record, release to send. Voice
 * state is announced as well as animated (§10) — a technician may be looking at
 * the vehicle, not the phone.
 */
export function PushToTalkButton({ disabled }: PushToTalkButtonProps) {
  const { status, levels, elapsedMs, error } = useAppSelector((s) => s.voice);
  const { start, stop } = useRecorder();
  const recording = status === "recording";

  const label = recording
    ? `Recording, ${formatElapsed(elapsedMs)}. Release to send.`
    : status === "transcribing"
      ? "Writing down what you said"
      : "Hold to speak";

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        disabled={disabled || status === "transcribing"}
        onPointerDown={() => void start()}
        onPointerUp={() => void stop()}
        onPointerLeave={() => recording && void stop()}
        aria-label={label}
        className={cn(
          "flex h-10 shrink-0 items-center justify-center gap-2 rounded-full transition-colors",
          // Hold-to-record must not double as a scroll gesture or pop the iOS callout menu.
          "touch-none select-none [-webkit-touch-callout:none]",
          "disabled:opacity-60",
          recording
            ? "bg-destructive text-destructive-foreground px-4"
            : "text-muted-foreground hover:bg-accent hover:text-foreground w-10",
        )}
      >
        {recording ? (
          <>
            <Square className="size-4 shrink-0 fill-current" aria-hidden />
            <Waveform levels={levels} />
            <span className="text-sm tabular-nums">{formatElapsed(elapsedMs)}</span>
          </>
        ) : (
          <Mic className="size-5 shrink-0" aria-hidden />
        )}
      </button>

      <p role="status" className="text-muted-foreground min-w-0 truncate text-sm">
        {error ?? (recording ? "Release to send" : status === "transcribing" ? "Writing it down…" : "")}
      </p>
    </div>
  );
}
