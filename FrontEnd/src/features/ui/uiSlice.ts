import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ThemePreference = "light" | "dark" | "system";

export interface UiState {
  theme: ThemePreference;
  /** Chunk id of the citation whose source drawer is open, if any. */
  activeCitationId: string | null;
  vehicleSheetOpen: boolean;
  handoffSheetOpen: boolean;
  /** Tap-to-reveal replaces hover for every tooltip (§1). */
  revealedTooltipId: string | null;
}

const initialState: UiState = {
  theme: "system",
  activeCitationId: null,
  vehicleSheetOpen: false,
  handoffSheetOpen: false,
  revealedTooltipId: null,
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    themeChanged(state, action: PayloadAction<ThemePreference>) {
      state.theme = action.payload;
    },
    citationOpened(state, action: PayloadAction<string>) {
      state.activeCitationId = action.payload;
    },
    citationClosed(state) {
      state.activeCitationId = null;
    },
    vehicleSheetToggled(state, action: PayloadAction<boolean>) {
      state.vehicleSheetOpen = action.payload;
    },
    handoffSheetToggled(state, action: PayloadAction<boolean>) {
      state.handoffSheetOpen = action.payload;
    },
    tooltipRevealed(state, action: PayloadAction<string | null>) {
      state.revealedTooltipId = action.payload;
    },
  },
});

export const uiActions = uiSlice.actions;
export default uiSlice.reducer;
