import { Mic, Square } from "lucide-react";
import { useAppSelector } from "@/app/hooks";
import { useRecorder } from "@/features/voice/hooks/useRecorder";
import { Waveform } from "@/features/voice/components/Waveform";
import { cn } from "@/lib/utils";

interface PushToTalkButtonProps {
  disabled?: boolean;
  /** The transcribed question, ready to send. */
  onTranscript: (text: string) => void;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A round mic button inside the composer. Tap to start recording, tap again to stop: the clip is transcribed and the question is sent. Voice
 * state is announced as well as animated (§10) — a technician may be looking at
 * the vehicle, not the phone.
 */
export function PushToTalkButton({ disabled, onTranscript }: PushToTalkButtonProps) {
  const { status, levels, elapsedMs, error } = useAppSelector((s) => s.voice);
  const { start, stop } = useRecorder({ onTranscript });
  const recording = status === "recording";
  const toggle = () => void (recording ? stop() : start());

  const label = recording
    ? `Recording, ${formatElapsed(elapsedMs)}. Tap to stop and send.`
    : status === "transcribing"
      ? "Writing down what you said"
      : "Tap to speak";

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        disabled={disabled || status === "transcribing"}
        onClick={toggle}
        aria-label={label}
        className={cn(
          "flex h-10 shrink-0 items-center justify-center gap-2 rounded-full transition-colors",
          "select-none",
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
        {error ?? (recording ? "Tap to stop and send" : status === "transcribing" ? "Writing it down…" : "")}
      </p>
    </div>
  );
}
