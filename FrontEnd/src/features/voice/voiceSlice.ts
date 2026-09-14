import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/** Device state, not server state — it could never be refetched. */
export type RecorderStatus =
  | "idle"
  | "permission_pending"
  | "permission_denied"
  | "recording"
  | "transcribing"
  | "preview"
  | "error";

export interface VoiceState {
  status: RecorderStatus;
  /** Milliseconds since recording started. Drives the waveform and the timer. */
  elapsedMs: number;
  /** Recent amplitude samples, 0–1, for the waveform. Capped, not unbounded. */
  levels: number[];
  /** Transcript shown for confirmation before anything is sent. */
  transcript: string | null;
  /**
   * iOS records to audio/mp4, not audio/webm (§10). Hardcoding webm makes voice
   * fail silently on every iPhone, so the chosen type is recorded here.
   */
  mimeType: string | null;
  ttsPlaying: boolean;
  error: string | null;
}

const MAX_LEVELS = 48;

const initialState: VoiceState = {
  status: "idle",
  elapsedMs: 0,
  levels: [],
  transcript: null,
  mimeType: null,
  ttsPlaying: false,
  error: null,
};

const voiceSlice = createSlice({
  name: "voice",
  initialState,
  reducers: {
    permissionRequested(state) {
      state.status = "permission_pending";
      state.error = null;
    },
    permissionDenied(state) {
      state.status = "permission_denied";
      state.error = "Microphone access is off. Turn it on in settings to use voice.";
    },
    recordingStarted(state, action: PayloadAction<{ mimeType: string }>) {
      state.status = "recording";
      state.mimeType = action.payload.mimeType;
      state.elapsedMs = 0;
      state.levels = [];
      state.transcript = null;
      state.error = null;
    },
    levelSampled(state, action: PayloadAction<number>) {
      state.levels.push(action.payload);
      if (state.levels.length > MAX_LEVELS) state.levels.shift();
    },
    elapsedTicked(state, action: PayloadAction<number>) {
      state.elapsedMs = action.payload;
    },
    recordingStopped(state) {
      state.status = "transcribing";
    },
    transcriptReady(state, action: PayloadAction<string>) {
      state.status = "preview";
      state.transcript = action.payload;
    },
    transcriptEdited(state, action: PayloadAction<string>) {
      state.transcript = action.payload;
    },
    ttsPlaybackChanged(state, action: PayloadAction<boolean>) {
      state.ttsPlaying = action.payload;
    },
    failed(state, action: PayloadAction<string>) {
      state.status = "error";
      state.error = action.payload;
    },
    reset() {
      return initialState;
    },
  },
});

export const voiceActions = voiceSlice.actions;
export default voiceSlice.reducer;
