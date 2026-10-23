import { useCallback, useEffect, useRef } from "react";
import { useAppDispatch } from "@/app/hooks";
import { voiceActions } from "@/features/voice/voiceSlice";
import { apiFetch } from "@/lib/api-client";

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

/** Shorter than this is a stray tap, not speech. */
const MIN_RECORDING_MS = 400;

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

/** Whisper picks its decoder from the file extension, so the name has to match the container. */
function fileNameFor(mimeType: string): string {
  return mimeType.startsWith("audio/mp4") ? "voice.mp4" : "voice.webm";
}

interface TranscribeResponse {
  success: boolean;
  data?: { text: string };
}

/**
 * Hold-to-talk capture: records, meters the level for the waveform, and posts the
 * clip to /audio/transcribe. The transcript lands in the preview step, never sent
 * straight to the chat.
 */
export function useRecorder({ onTranscript }: UseRecorderOptions) {
  const dispatch = useAppDispatch();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const meterRef = useRef<{ ctx: AudioContext; timer: number } | null>(null);
  // Set when the button is released while the mic permission prompt is still open.
  const releasedEarlyRef = useRef(false);
  const startingRef = useRef(false);

  const stopMeter = useCallback(() => {
    if (!meterRef.current) return;
    window.clearInterval(meterRef.current.timer);
    void meterRef.current.ctx.close().catch(() => {});
    meterRef.current = null;
  }, []);

  const releaseStream = useCallback(() => {
    stopMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, [stopMeter]);

  const startMeter = useCallback(
    (stream: MediaStream) => {
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);

        const timer = window.setInterval(() => {
          analyser.getByteTimeDomainData(samples);
          let peak = 0;
          for (const s of samples) peak = Math.max(peak, Math.abs(s - 128));
          dispatch(voiceActions.levelSampled(Math.min(1, peak / 64)));
          dispatch(voiceActions.elapsedTicked(Date.now() - startedAtRef.current));
        }, 100);

        meterRef.current = { ctx, timer };
      } catch {
        // No metering is not a reason to lose the recording.
      }
    },
    [dispatch],
  );

  // Leaving the screen mid-recording must not leave the mic light on.
  useEffect(() => releaseStream, [releaseStream]);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder) {
      // Released before the mic was granted: start() will see this and bail out.
      if (startingRef.current) releasedEarlyRef.current = true;
      return null;
    }

    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = recorder.mimeType;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: mimeType }));
      recorder.stop();
    });
    releaseStream();

    if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
      dispatch(voiceActions.failed("That was too short. Hold the button while you speak."));
      return null;
    }

    dispatch(voiceActions.recordingStopped());

    try {
      const form = new FormData();
      form.append("audio", blob, fileNameFor(mimeType));
      const res = await apiFetch<TranscribeResponse>("/audio/transcribe", { method: "POST", body: form });
      const text = res.data?.text?.trim() ?? "";
      if (!text) {
        dispatch(voiceActions.failed("I couldn't hear anything. Try again, or type the question."));
        return blob;
      }
      dispatch(voiceActions.transcriptReady(text));
    } catch {
      dispatch(voiceActions.failed("Couldn't turn that into text. Try again, or type the question."));
    }
    return blob;
  }, [dispatch, releaseStream]);

  const start = useCallback(async () => {
    if (startingRef.current || recorderRef.current) return;

    const mimeType = pickMimeType();
    if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
      dispatch(voiceActions.failed("This browser can't record audio. Type the question instead."));
      return;
    }

    startingRef.current = true;
    releasedEarlyRef.current = false;
    dispatch(voiceActions.permissionRequested());

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (releasedEarlyRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        dispatch(voiceActions.reset());
        return;
      }

      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(250);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();

      dispatch(voiceActions.recordingStarted({ mimeType }));
      startMeter(stream);
    } catch {
      dispatch(voiceActions.permissionDenied());
    } finally {
      startingRef.current = false;
    }
  }, [dispatch, startMeter]);

  const cancel = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    releaseStream();
    dispatch(voiceActions.reset());
  }, [dispatch, releaseStream]);

  return { start, stop, cancel };
}
