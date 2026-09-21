import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";

// INV-4: tunables are rows in `setting`, never constants in code. Cached for
// 5 minutes per DATABASE.md Phase 5 spec — long enough to avoid a query per
// request, short enough that an admin's edit takes effect without a restart.
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { values: Map<string, unknown>; expiresAt: number } | null = null;

const loadSettings = async (): Promise<Map<string, unknown>> => {
  const { orgId, workflowId } = await getDefaultOrg();
  const { rows } = await pool.query<{ key: string; value_json: unknown }>(
    `select key, value_json from setting where org_id = $1 and workflow_id = $2`,
    [orgId, workflowId]
  );
  return new Map(rows.map((r) => [r.key, r.value_json]));
};

const getAll = async (): Promise<Map<string, unknown>> => {
  if (cache && cache.expiresAt > Date.now()) return cache.values;
  const values = await loadSettings();
  cache = { values, expiresAt: Date.now() + CACHE_TTL_MS };
  return values;
};

/** Invalidates the in-process cache — call after a settings.edit write. */
export const invalidateSettingsCache = (): void => {
  cache = null;
};

const get = async <T>(key: string, fallback: T): Promise<T> => {
  const values = await getAll();
  return values.has(key) ? (values.get(key) as T) : fallback;
};

export const getRetrievalMatchCount = () => get<number>("retrieval.match_count", 8);
export const getRetrievalAdmitMinSimilarity = () => get<number>("retrieval.admit_min_similarity", 0.35);
export const getRetrievalAdmitOnExactCode = () => get<boolean>("retrieval.admit_on_exact_code", true);
export const getEmbeddingModel = () => get<string>("gate.embedding_model", "text-embedding-3-small");
export const getAnswerModel = () => get<string>("gate.answer_model", "gpt-4o-mini");
