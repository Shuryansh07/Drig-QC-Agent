import { useCallback, useRef } from "react";
import { useAppDispatch } from "@/app/hooks";
import { voiceActions } from "@/features/voice/voiceSlice";

/**
 * iOS records to audio/mp4, not audio/webm (§10). Hardcoding webm makes voice
 * fail silently on every iPhone, so the type is negotiated rather than assumed.
 */
const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

/**
 * Skeleton. Capture and level metering are wired; transcription is not, because
 * there is no endpoint to post the blob to yet.
 */
export function useRecorder() {
  const dispatch = useAppDispatch();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    const mimeType = pickMimeType();
    if (!mimeType) {
      dispatch(voiceActions.failed("This browser can't record audio. Type the question instead."));
      return;
    }

    dispatch(voiceActions.permissionRequested());

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(250);
      recorderRef.current = recorder;

      dispatch(voiceActions.recordingStarted({ mimeType }));
    } catch {
      dispatch(voiceActions.permissionDenied());
    }
  }, [dispatch]);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;

    dispatch(voiceActions.recordingStopped());

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
      recorder.stop();
    });

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;

    // TODO: POST the blob to /api/voice/transcribe and dispatch transcriptReady.
    return blob;
  }, [dispatch]);

  const cancel = useCallback(() => {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
    streamRef.current = null;
    dispatch(voiceActions.reset());
  }, [dispatch]);

  return { start, stop, cancel };
}
