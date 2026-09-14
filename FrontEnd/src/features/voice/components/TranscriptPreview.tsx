import { useAppDispatch, useAppSelector } from "@/app/hooks";
import { voiceActions } from "@/features/voice/voiceSlice";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface TranscriptPreviewProps {
  onSend: (text: string) => void;
}

/**
 * Nothing is sent until the technician has seen it. Workshop noise garbles
 * transcription often enough that silent sending would waste a whole turn.
 */
export function TranscriptPreview({ onSend }: TranscriptPreviewProps) {
  const { status, transcript } = useAppSelector((s) => s.voice);
  const dispatch = useAppDispatch();

  if (status !== "preview" || transcript === null) return null;

  return (
    <div className="border-border bg-card space-y-3 rounded-xl border p-4">
      <Textarea
        value={transcript}
        onChange={(e) => dispatch(voiceActions.transcriptEdited(e.target.value))}
        rows={3}
        aria-label="What you said"
        className="text-body resize-none"
      />
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          onClick={() => dispatch(voiceActions.reset())}
          className="h-touch text-body"
        >
          Try again
        </Button>
        <Button
          onClick={() => {
            onSend(transcript);
            dispatch(voiceActions.reset());
          }}
          className="h-touch text-body"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
