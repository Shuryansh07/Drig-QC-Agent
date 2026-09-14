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
 * Bottom-centre, hold to record, full width. Voice state is announced as well as
 * animated (§10) — a technician may be looking at the vehicle, not the phone.
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
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled || status === "transcribing"}
        onPointerDown={() => void start()}
        onPointerUp={() => void stop()}
        onPointerLeave={() => recording && void stop()}
        aria-label={label}
        className={cn(
          "flex h-touch-lg w-full items-center justify-center gap-3 rounded-xl",
          "text-step font-semibold transition-colors",
          // Hold-to-record must not double as a scroll gesture or pop the
          // iOS callout menu.
          "touch-none select-none [-webkit-touch-callout:none]",
          "disabled:opacity-60",
          recording
            ? "bg-destructive text-destructive-foreground"
            : "bg-primary text-primary-foreground active:brightness-95",
        )}
      >
        {recording ? (
          <>
            <Square className="size-5 shrink-0 fill-current" aria-hidden />
            <Waveform levels={levels} />
            <span className="tabular-nums">{formatElapsed(elapsedMs)}</span>
          </>
        ) : (
          <>
            <Mic className="size-6 shrink-0" aria-hidden />
            {status === "transcribing" ? "Writing it down" : "Hold to speak"}
          </>
        )}
      </button>

      <p role="status" className="text-micro text-muted-foreground min-h-5 text-center">
        {error ?? (recording ? "Release to send" : "")}
      </p>
    </div>
  );
}
