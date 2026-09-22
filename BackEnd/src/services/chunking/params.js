import { getSetting } from "../../db/settings.js";
import { logger } from "../../utils/logger.js";

/**
 * Chunk sizing, in estimated tokens. INV-4: the source of truth is the
 * `chunk.*` rows in the `setting` table (seeded by migration 0730); these
 * defaults are the same values, used only when a row is missing (e.g. the
 * migration has not been applied to this database yet) and by the offline
 * preview script.
 *
 * Starting values, to be tuned on the golden question set rather than by feel:
 *   child 150-400   small enough to match one specific symptom or part code
 *   procedure 800   a whole numbered procedure stays in one child up to this
 *   parent 150-1200 one heading section: what the answer model actually reads
 */
export const DEFAULT_CHUNK_PARAMS = {
  childTargetTokens: 250,
  childMaxTokens: 380,
  childOverlapTokens: 30,
  procedureMaxTokens: 800,
  parentMinTokens: 150,
  parentMaxTokens: 1200,
};

const SETTING_KEYS = {
  childTargetTokens: "chunk.child_target_tokens",
  childMaxTokens: "chunk.child_max_tokens",
  childOverlapTokens: "chunk.child_overlap_tokens",
  procedureMaxTokens: "chunk.procedure_max_tokens",
  parentMinTokens: "chunk.parent_min_tokens",
  parentMaxTokens: "chunk.parent_max_tokens",
};

export const loadChunkParams = async () => {
  const params = {};
  const missing = [];

  for (const [name, key] of Object.entries(SETTING_KEYS)) {
    const value = await getSetting(key, undefined);
    if (typeof value === "number" && value > 0) params[name] = value;
    else {
      params[name] = DEFAULT_CHUNK_PARAMS[name];
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    logger.warn(`[chunking] using built-in defaults for ${missing.join(", ")} — apply migration 20260921000730 to seed them`);
  }
  return params;
};
