import { generateEmbedding } from "./embedding.service.js";
import { matchChunks } from "../db/retrieval.js";
import { getChunksByIds } from "../db/chunks.js";
import { getDefaultOrg } from "../db/org.js";
import { getRetrievalMatchCount, getRetrievalAdmitMinSimilarity, getRetrievalAdmitOnExactCode } from "../db/settings.js";
import { withTiming } from "../utils/timing.js";

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
 * @returns {{ chunks: object[], admission: object, embedding: number[], candidateIds: string[] }}
 *   `chunks` is empty whenever the gate refuses, so a caller that forgets to
 *   check `admission` still cannot generate from rejected material.
 */
export const retrieveRelevantChunks = async ({ question }) => {
  const { orgId } = await getDefaultOrg();
  const embedding = await generateEmbedding(question);
  const [matchCount, minSimilarity, admitOnExactCode] = await Promise.all([
    getRetrievalMatchCount(),
    getRetrievalAdmitMinSimilarity(),
    getRetrievalAdmitOnExactCode(),
  ]);

  const matches = await withTiming("match_chunks()", () =>
    matchChunks({ orgId, queryEmbedding: embedding, queryText: question, matchCount })
  );

  const admission = decideAdmission({ matches, question, minSimilarity, admitOnExactCode });
  const candidateIds = matches.map((m) => m.chunkId);

  if (!admission.admitted) return { chunks: [], admission, embedding, candidateIds };

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
      sectionPath: chunk.sectionPath,
      documentTitle: chunk.documentTitle,
      content: chunk.parentContent ?? chunk.content,
      similarity: match.denseSimilarity,
    });
  }

  return { chunks, admission, embedding, candidateIds };
};
