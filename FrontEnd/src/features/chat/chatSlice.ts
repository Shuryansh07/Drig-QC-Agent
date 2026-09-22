import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ChatState } from "@/features/chat/types";
import type { Resolution, ServerEvent } from "@/types/contracts";

const emptyStream = {
  turnId: null,
  status: "idle",
  stage: null,
  slow: false,
  steps: [],
  partialText: "",
  citations: [],
  gateOutcome: null,
  clarify: null,
  notCovered: null,
  conflict: null,
  deadlineWarning: false,
  error: null,
} satisfies Omit<ChatState, "sessionId" | "draft" | "frame" | "recentCorrections">;

const initialState: ChatState = {
  ...emptyStream,
  sessionId: null,
  draft: "",
  frame: null,
  recentCorrections: [],
};

const chatSlice = createSlice({
  name: "chat",
  initialState,
  reducers: {
    sessionStarted(state, action: PayloadAction<string>) {
      state.sessionId = action.payload;
      state.frame = null;
      state.recentCorrections = [];
      Object.assign(state, emptyStream);
    },

    draftChanged(state, action: PayloadAction<string>) {
      state.draft = action.payload;
    },

    streamStarted(state) {
      Object.assign(state, emptyStream);
      state.status = "thinking";
      state.draft = "";
    },

    stageChanged(state, action: PayloadAction<"retrieving" | "generating">) {
      state.stage = action.payload;
    },

    /** Answer text arriving token by token. Coalesced by the caller, one dispatch per frame. */
    answerDelta(state, action: PayloadAction<string>) {
      state.partialText += action.payload;
      state.status = "streaming";
      state.slow = false;
    },

    /** Nothing has come back for a while. Only meaningful before the first text. */
    slowResponse(state) {
      if (state.partialText.length === 0 && (state.status === "thinking" || state.status === "streaming")) {
        state.slow = true;
      }
    },

    /**
     * Single entry point for every server event (§4). Keeping the switch in one
     * reducer means an unhandled event type is a compile error, not a silent drop.
     */
    serverEvent(state, action: PayloadAction<ServerEvent>) {
      const event = action.payload;

      switch (event.type) {
        case "frame":
          state.frame = event.frame;
          state.recentCorrections = event.corrections;
          break;

        case "clarify":
          state.clarify = event.clarify;
          state.gateOutcome = "clarify";
          state.status = "done";
          break;

        case "step":
          state.status = "streaming";
          state.steps.push(event.step);
          break;

        case "citation":
          if (!state.citations.some((c) => c.chunkId === event.citation.chunkId)) {
            state.citations.push(event.citation);
          }
          break;

        case "not_covered":
          state.notCovered = event.notCovered;
          state.gateOutcome = "not_covered";
          state.status = "refused";
          break;

        case "conflict":
          state.conflict = event.conflict;
          state.gateOutcome = "conflict";
          state.status = "refused";
          break;

        case "deadline_warning":
          state.deadlineWarning = true;
          break;

        case "done":
          state.turnId = event.turn.turnId;
          state.gateOutcome = event.turn.gateOutcome;
          state.status = "done";
          break;

        case "error":
          state.error = { code: event.code, message: event.message };
          state.status = "error";
          break;
      }
    },

    streamCancelled(state) {
      Object.assign(state, emptyStream);
    },

    /** Called after the finished turn has been written into the query cache. */
    clearStream(state) {
      Object.assign(state, emptyStream);
    },

    resolutionRecorded(state, _action: PayloadAction<Resolution>) {
      // The resolution itself is a server mutation; the buffer just steps aside.
      Object.assign(state, emptyStream);
    },
  },
});

export const chatActions = chatSlice.actions;
export default chatSlice.reducer;
