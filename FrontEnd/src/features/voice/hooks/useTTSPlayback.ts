import { useCallback } from "react";
import { toast } from "sonner";
import { useAppDispatch } from "@/app/hooks";
import { voiceActions } from "@/features/voice/voiceSlice";
import { apiFetch, apiUrl } from "@/lib/api-client";

/** An empty sound. iOS only lets audio play from a tap, so this plays on the tap and the answer takes over after the fetch. */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

// One player for the app: two answers must never talk over each other.
const player = typeof Audio === "undefined" ? null : new Audio();
// Each press takes the next number; a slow fetch that is no longer the latest press stays quiet.
let latestPress = 0;
/** A stream that dies part-way fires neither "ended" nor "error": the player just waits, so waiting has a limit. */
const STALL_LIMIT_MS = 20_000;
let stallTimer: number | undefined;

function clearPlayer() {
  window.clearTimeout(stallTimer);
  if (!player) return;
  player.onended = null;
  player.onerror = null;
  player.onwaiting = null;
  player.onplaying = null;
}

function silencePlayer() {
  clearPlayer();
  if (!player) return;
  player.pause();
  // Pausing alone would hold the stream open.
  player.removeAttribute("src");
  player.load();
}

/**
 * Reading an answer aloud matters when both hands are inside a dash. The audio element plays the
 * server's stream as it arrives, so the first words don't wait for the whole answer to be generated.
 * The server keeps a generated clip, so replaying an answer isn't billed again.
 */
export function useTTSPlayback() {
  const dispatch = useAppDispatch();

  const stop = useCallback(() => {
    latestPress += 1;
    silencePlayer();
    dispatch(voiceActions.ttsPlaybackChanged(null));
  }, [dispatch]);

  const speak = useCallback(
    async (turnId: string, text: string) => {
      if (!player) return;
      const press = ++latestPress;
      const finished = () => {
        if (press !== latestPress) return;
        clearPlayer();
        dispatch(voiceActions.ttsPlaybackChanged(null));
      };
      // Audio that stops part-way must say so: a technician could take a missing step as the end of the answer.
      const failed = () => {
        if (press !== latestPress) return;
        latestPress += 1;
        silencePlayer();
        dispatch(voiceActions.ttsPlaybackChanged(null));
        toast.error("Couldn't finish reading that aloud. Try again.");
      };

      clearPlayer();
      player.src = SILENCE;
      void player.play().catch(() => {});
      dispatch(voiceActions.ttsPlaybackChanged({ turnId, loading: true }));

      try {
        const { id } = await apiFetch<{ id: string }>("/audio/speech", {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        if (press !== latestPress) return;
        player.onended = finished;
        player.onerror = failed;
        player.onwaiting = () => {
          window.clearTimeout(stallTimer);
          stallTimer = window.setTimeout(failed, STALL_LIMIT_MS);
        };
        player.onplaying = () => window.clearTimeout(stallTimer);
        player.src = apiUrl(`/audio/speech/${id}`);
        await player.play();
        if (press === latestPress) dispatch(voiceActions.ttsPlaybackChanged({ turnId, loading: false }));
      } catch {
        failed();
      }
    },
    [dispatch],
  );

  return { speak, stop };
}
