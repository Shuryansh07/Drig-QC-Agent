import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { loadOutbox, saveOutbox } from "@/lib/offline";

/**
 * A question typed with no signal. It has no server representation yet, so it
 * cannot live in the query cache — and it must survive a reload, so it cannot
 * live only in memory (§3, §9).
 */
export interface OutboxEntry {
  id: string;
  sessionId: string;
  text: string;
  queuedAt: string;
  attempts: number;
  lastError: string | null;
}

export interface OutboxState {
  entries: OutboxEntry[];
  flushing: boolean;
}

const initialState: OutboxState = {
  entries: loadOutbox(),
  flushing: false,
};

const outboxSlice = createSlice({
  name: "outbox",
  initialState,
  reducers: {
    queued(state, action: PayloadAction<{ sessionId: string; text: string }>) {
      state.entries.push({
        id: crypto.randomUUID(),
        sessionId: action.payload.sessionId,
        text: action.payload.text,
        queuedAt: new Date().toISOString(),
        attempts: 0,
        lastError: null,
      });
      saveOutbox(state.entries);
    },
    flushStarted(state) {
      state.flushing = true;
    },
    sent(state, action: PayloadAction<string>) {
      state.entries = state.entries.filter((e) => e.id !== action.payload);
      saveOutbox(state.entries);
    },
    sendFailed(state, action: PayloadAction<{ id: string; error: string }>) {
      const entry = state.entries.find((e) => e.id === action.payload.id);
      if (entry) {
        entry.attempts += 1;
        entry.lastError = action.payload.error;
        saveOutbox(state.entries);
      }
    },
    flushFinished(state) {
      state.flushing = false;
    },
    discarded(state, action: PayloadAction<string>) {
      state.entries = state.entries.filter((e) => e.id !== action.payload);
      saveOutbox(state.entries);
    },
  },
});

export const outboxActions = outboxSlice.actions;
export default outboxSlice.reducer;
