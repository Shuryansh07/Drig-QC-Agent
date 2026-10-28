import { generateEmbedding } from "./embedding.service.js";
import { matchChunks } from "../db/retrieval.js";
import { getChunksByIds } from "../db/chunks.js";
import { getDefaultOrg } from "../db/org.js";
import {
  getRetrievalMatchCount,
  getRetrievalAdmitMinSimilarity,
  getRetrievalAdmitOnExactCode,
  getRetrievalEquipmentFilterEnabled,
} from "../db/settings.js";
import { resolveEquipmentFilter } from "./equipmentFilter.service.js";
import { listLiveDrigDocIds } from "../db/documents.js";
import { withTiming } from "../utils/timing.js";
import { logger } from "../utils/logger.js";

// Short: a manual just marked DRIG Standard should be preferred within a minute.
const DRIG_IDS_TTL_MS = 60 * 1000;
let drigIdsCache = null;

/** Live DRIG Standard manuals. A failure means "none": retrieval then searches everything, as before. */
const liveDrigDocIds = async () => {
  if (drigIdsCache && drigIdsCache.expiresAt > Date.now()) return drigIdsCache.ids;
  try {
    const ids = await listLiveDrigDocIds();
    drigIdsCache = { ids, expiresAt: Date.now() + DRIG_IDS_TTL_MS };
    return ids;
  } catch (err) {
    logger.warn(`[retrieval] could not load the DRIG Standard manuals (${err.message}); searching all manuals`);
    return [];
  }
};

// A model or part code: letters AND digits in one token ("5550X-VM", "N4",
// "EC1004"). A bare number ("5550") or a bare word is not one.
const EXACT_CODE_RE = /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]{2,}(?:-[A-Za-z0-9]+)*\b/;

export const containsExactCode = (question) => EXACT_CODE_RE.test(question);

/**
 * Gate 2 (Blueprint "Check 2 — did we find anything worth using?"): decides
 * whether what was retrieved is good enough to write an answer from.
 *
 * An LLM handed thin material and asked to be helpful will produce something
 * helpful-sounding. Refusing here, before the LLM is ever called, removes that
 * failure instead of trying to prompt around it.
 *
 * Thresholds on dense_similarity (cosine, 0..1), NOT on `score`: the fused
 * score is rank-based and not comparable across queries (DATABASE.md §6.1).
 * A keyword hit on an exact model/part code also admits, because a code the
 * embedding model has never seen scores low on similarity but is a certain match.
 */
export const decideAdmission = ({ matches, question, minSimilarity, admitOnExactCode }) => {
  const topSimilarity = matches.reduce((max, m) => Math.max(max, m.denseSimilarity ?? 0), 0);

  if (matches.length === 0) return { admitted: false, reason: "no_matches", topSimilarity };
  if (topSimilarity >= minSimilarity) return { admitted: true, reason: "similarity", topSimilarity };

  if (admitOnExactCode && containsExactCode(question) && matches.some((m) => m.lexicalRank !== null && m.lexicalRank !== undefined)) {
    return { admitted: true, reason: "exact_code", topSimilarity };
  }

  return { admitted: false, reason: "below_threshold", topSimilarity };
};

/**
 * Embeds the question, runs match_chunks() (rule P5 — no raw `<=>` here),
 * applies the admission gate, then fetches the matched chunks' text by id.
 * match_chunks only ever returns is_live chunks for the current org (tenancy +
 * liveness are hard filters inside the function itself, not applied here).
 *
 * Parent/child (DATABASE.md §6.1): the match is a small child chunk, but the
 * answer model is sent that child's PARENT section — the full procedure with
 * its warnings and context. Two children of the same section would send it
 * twice, so results are de-duplicated by parent, keeping the best-ranked
 * child (matches arrive best-first) for the page citation.
 *
 * Equipment filter: when the question names a product, the search is limited
 * to the documents about that product (equipmentFilter.service.js), resolved
 * alongside the embedding so it adds little delay. If that filtered search
 * finds nothing at all, it is run again over everything, so a filter that
 * picked too narrowly costs one query, never the answer.
 *
 * DRIG Standard manuals (kb_document.collection = 'drig') are searched first,
 * within the equipment filter when there is one. If that search passes the
 * same admission gate, it is the answer's evidence and nothing else is
 * searched; otherwise retrieval carries on over every manual as above.
 * `admission.tier` says which ("drig" | "all").
 *
 * @returns {{ chunks: object[], admission: object, embedding: number[], candidateIds: string[], equipment: object }}
 *   `chunks` is empty whenever the gate refuses, so a caller that forgets to
 *   check `admission` still cannot generate from rejected material.
 */
export const retrieveRelevantChunks = async ({ question }) => {
  const { orgId } = await getDefaultOrg();
  const filterEnabled = await getRetrievalEquipmentFilterEnabled().catch(() => true);
  const [embedding, equipment] = await Promise.all([
    generateEmbedding(question),
    filterEnabled ? withTiming("equipment filter", () => resolveEquipmentFilter(question)) : { equipment: [], docIds: null },
  ]);
  const [matchCount, minSimilarity, admitOnExactCode] = await Promise.all([
    getRetrievalMatchCount(),
    getRetrievalAdmitMinSimilarity(),
    getRetrievalAdmitOnExactCode(),
  ]);

  const search = (docIds) =>
    withTiming("match_chunks()", () => matchChunks({ orgId, queryEmbedding: embedding, queryText: question, matchCount, docIds }));

  // DRIG Standard manuals first. When they answer the question well enough to pass the same gate,
  // the answer comes from them alone; only otherwise are the other manuals searched.
  const drigDocIds = await liveDrigDocIds();
  const drigScope = drigDocIds.length === 0 ? [] : equipment.docIds ? equipment.docIds.filter((id) => drigDocIds.includes(id)) : drigDocIds;
  if (drigScope.length > 0) {
    const drigMatches = await search(drigScope);
    const drigAdmission = decideAdmission({ matches: drigMatches, question, minSimilarity, admitOnExactCode });
    if (drigAdmission.admitted) {
      logger.info(`[retrieval] answered from DRIG Standard manuals (${drigScope.length} in scope, top similarity ${drigAdmission.topSimilarity.toFixed(3)})`);
      return assemble({ matches: drigMatches, admission: { ...drigAdmission, tier: "drig" }, embedding, equipment });
    }
    logger.info(`[retrieval] no DRIG Standard manual answers it (top similarity ${drigAdmission.topSimilarity.toFixed(3)}); searching all manuals`);
  }

  let matches = await search(equipment.docIds);
  if (equipment.docIds && matches.length === 0) {
    logger.info(`[retrieval] nothing in the ${equipment.docIds.length} document(s) for "${equipment.equipment.join(", ")}"; searching everything`);
    matches = await search(null);
  }

  const admission = decideAdmission({ matches, question, minSimilarity, admitOnExactCode });
  return assemble({ matches, admission: { ...admission, tier: "all" }, embedding, equipment });
};

/** Fetches the matched chunks' text and shapes them for the answer step (parent sections, de-duplicated). */
const assemble = async ({ matches, admission, embedding, equipment }) => {
  const candidateIds = matches.map((m) => m.chunkId);

  if (!admission.admitted) return { chunks: [], admission, embedding, candidateIds, equipment };

  const texts = await getChunksByIds(candidateIds);
  const textByChunkId = new Map(texts.map((t) => [t.chunkId, t]));

  const seen = new Set();
  const chunks = [];

  for (const match of matches) {
    const chunk = textByChunkId.get(match.chunkId);
    if (!chunk) continue;

    const groupKey = chunk.parentChunkId ?? chunk.chunkId;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);

    chunks.push({
      chunkId: chunk.chunkId,
      documentId: match.docId,
      pageNumber: chunk.pageFrom,
      pageLabel: chunk.pageLabel,
      sectionPath: chunk.sectionPath,
      documentTitle: chunk.documentTitle,
      content: chunk.parentContent ?? chunk.content,
      similarity: match.denseSimilarity,
      // Lets the answer step fetch the drawing itself (answerGeneration.service.js).
      imageHash: chunk.metadata?.imageHash ?? null,
    });
  }

  return { chunks, admission, embedding, candidateIds, equipment };
};
