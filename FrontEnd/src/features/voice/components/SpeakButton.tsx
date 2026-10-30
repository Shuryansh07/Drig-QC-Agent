import { Loader2, Square, Volume2 } from "lucide-react";
import { useAppSelector } from "@/app/hooks";
import { useTTSPlayback } from "@/features/voice/hooks/useTTSPlayback";
import { Button } from "@/components/ui/button";

interface SpeakButtonProps {
  turnId: string;
  text: string;
}

/** Reads one answer aloud. Pressing it again, or while the audio is loading, stops it. */
export function SpeakButton({ turnId, text }: SpeakButtonProps) {
  const tts = useAppSelector((s) => s.voice.tts);
  const { speak, stop } = useTTSPlayback();
  const active = tts?.turnId === turnId;
  const loading = active && tts.loading;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={active}
      onClick={() => (active ? stop() : void speak(turnId, text))}
      className="min-h-10 rounded-full px-4 text-sm"
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : active ? <Square aria-hidden /> : <Volume2 aria-hidden />}
      {loading ? "Getting audio…" : active ? "Stop" : "Read aloud"}
    </Button>
  );
}
