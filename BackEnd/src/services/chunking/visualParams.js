import { getSetting } from "../../db/settings.js";
import { logger } from "../../utils/logger.js";

/**
 * Vision-step tunables (INV-4). The source of truth is the `vision.*` rows in the
 * `setting` table (migration 0740); these are the same values, used only when a
 * row is missing (migration not yet applied) and by offline scripts.
 */
export const DEFAULT_VISUAL_PARAMS = {
  enabled: true,
  maxVisualsPerDocument: 40,
  pageRenderScale: 2,
  minImagePx: 100,
  minVectorOps: 150,
};

const SETTING_KEYS = {
  enabled: "vision.enabled",
  maxVisualsPerDocument: "vision.max_visuals_per_document",
  pageRenderScale: "vision.page_render_scale",
  minImagePx: "vision.min_image_px",
  minVectorOps: "vision.min_vector_ops",
};

export const loadVisualParams = async () => {
  const params = {};
  const missing = [];

  for (const [name, key] of Object.entries(SETTING_KEYS)) {
    const value = await getSetting(key, undefined);
    const expected = typeof DEFAULT_VISUAL_PARAMS[name];
    if (typeof value === expected && (expected !== "number" || value > 0)) params[name] = value;
    else {
      params[name] = DEFAULT_VISUAL_PARAMS[name];
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    logger.warn(`[vision] using built-in defaults for ${missing.join(", ")} — apply migration 20260921000740 to seed them`);
  }
  return params;
};
