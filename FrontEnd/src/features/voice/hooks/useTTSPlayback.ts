import { useCallback, useRef } from "react";
import { useAppDispatch } from "@/app/hooks";
import { voiceActions } from "@/features/voice/voiceSlice";

/**
 * Skeleton. Reading an answer aloud matters when both hands are inside a dash,
 * but there is no synthesis endpoint yet.
 */
export function useTTSPlayback() {
  const dispatch = useAppDispatch();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = useCallback(
    (src: string) => {
      audioRef.current?.pause();
      const audio = new Audio(src);
      audio.onended = () => dispatch(voiceActions.ttsPlaybackChanged(false));
      audio.onerror = () => dispatch(voiceActions.ttsPlaybackChanged(false));
      audioRef.current = audio;
      dispatch(voiceActions.ttsPlaybackChanged(true));
      void audio.play();
    },
    [dispatch],
  );

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    dispatch(voiceActions.ttsPlaybackChanged(false));
  }, [dispatch]);

  return { play, stop };
}
