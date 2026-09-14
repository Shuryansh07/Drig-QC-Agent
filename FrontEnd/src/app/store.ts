import { configureStore } from "@reduxjs/toolkit";
import chatReducer from "@/features/chat/chatSlice";
import voiceReducer from "@/features/voice/voiceSlice";
import uiReducer from "@/features/ui/uiSlice";
import outboxReducer from "@/features/outbox/outboxSlice";

/**
 * Slices only. No RTK Query — it would duplicate TanStack Query, and two copies
 * of server state is exactly the drift §3 exists to prevent.
 */
export const store = configureStore({
  reducer: {
    chat: chatReducer,
    voice: voiceReducer,
    ui: uiReducer,
    outbox: outboxReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
