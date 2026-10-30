import { useCallback } from "react";
import { toast } from "sonner";
import { useAppDispatch } from "@/app/hooks";
import { voiceActions } from "@/features/voice/voiceSlice";
import { apiUrl, authHeaders } from "@/lib/api-client";

/** An empty sound. iOS only lets audio play from a tap, so this plays on the tap and the answer takes over after the fetch. */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
/** Generated speech is billed, so replaying an answer reuses its clip. */
const MAX_CLIPS = 20;

// One player for the app: two answers must never talk over each other.
const player = typeof Audio === "undefined" ? null : new Audio();
const clips = new Map<string, string>();
// Each press takes the next number; a slow fetch that is no longer the latest press stays quiet.
let latestPress = 0;

async function fetchClip(text: string): Promise<string> {
  const cached = clips.get(text);
  if (cached) return cached;

  const res = await fetch(apiUrl("/audio/speech"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`speech failed: ${res.status}`);

  const clip = URL.createObjectURL(await res.blob());
  clips.set(text, clip);
  if (clips.size > MAX_CLIPS) {
    const [oldest] = clips;
    URL.revokeObjectURL(oldest[1]);
    clips.delete(oldest[0]);
  }
  return clip;
}

/** Reading an answer aloud matters when both hands are inside a dash. */
export function useTTSPlayback() {
  const dispatch = useAppDispatch();

  const stop = useCallback(() => {
    latestPress += 1;
    player?.pause();
    dispatch(voiceActions.ttsPlaybackChanged(null));
  }, [dispatch]);

  const speak = useCallback(
    async (turnId: string, text: string) => {
      if (!player) return;
      const press = ++latestPress;
      const finished = () => {
        if (press === latestPress) dispatch(voiceActions.ttsPlaybackChanged(null));
      };

      player.onended = null;
      player.onerror = null;
      player.src = SILENCE;
      void player.play().catch(() => {});
      dispatch(voiceActions.ttsPlaybackChanged({ turnId, loading: true }));

      try {
        const clip = await fetchClip(text);
        if (press !== latestPress) return;
        player.onended = finished;
        player.onerror = finished;
        player.src = clip;
        await player.play();
        if (press === latestPress) dispatch(voiceActions.ttsPlaybackChanged({ turnId, loading: false }));
      } catch {
        if (press !== latestPress) return;
        finished();
        toast.error("Couldn't read that aloud. Try again.");
      }
    },
    [dispatch],
  );

  return { speak, stop };
}
