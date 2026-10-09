import { generateEmbedding } from "./embedding.service.js";
import { getChunksByIds } from "../db/chunks.js";
import { matchFaq, addFaq, deactivateFaqOfTurn, liveChunkIds } from "../db/faq.js";
import { getFaqMinSimilarity, getFaqMatchCount, getFaqStrongSimilarity, getFaqDedupeSimilarity } from "../db/settings.js";
import { logger } from "../utils/logger.js";

// The FAQ: questions technicians marked "resolved", kept with the passages that
// answered them. A new question is searched against it as well as the manuals.
//
// A match helps in three ways, none of which lets an answer rest on the FAQ alone:
//   1. its source passages join the evidence (they are real, live chunks, so
//      citations and the verification checks still work on them);
//   2. its answer is shown to the answer model as a reference, never as evidence;
//   3. a very close match skips the clarification question and can admit a question
//      that retrieval alone would have refused.

const NONE = { matches: [], chunks: [], best: null, strong: false };

/** The resolved questions closest to this one, and the live passages that answered them. Never throws. */
export const findFaq = async ({ embedding }) => {
  try {
    const [minSimilarity, count, strongSimilarity] = await Promise.all([getFaqMinSimilarity(), getFaqMatchCount(), getFaqStrongSimilarity()]);
    const matches = await matchFaq(embedding, count, minSimilarity);
    if (matches.length === 0) return NONE;

    const similarityOf = new Map();
    for (const m of matches) for (const id of m.sourceChunkIds) similarityOf.set(id, Math.max(similarityOf.get(id) ?? 0, m.similarity));

    // A manual may have been replaced since the answer was resolved: only live passages are used.
    const live = await liveChunkIds([...similarityOf.keys()]);
    const texts = await getChunksByIds(live);

    const seen = new Set();
    const chunks = [];
    for (const t of texts.sort((a, b) => (similarityOf.get(b.chunkId) ?? 0) - (similarityOf.get(a.chunkId) ?? 0))) {
      const groupKey = t.parentChunkId ?? t.chunkId;
      if (seen.has(groupKey)) continue;
      seen.add(groupKey);
      chunks.push({
        chunkId: t.chunkId,
        documentId: t.docId,
        pageNumber: t.pageFrom,
        sectionPath: t.sectionPath,
        documentTitle: t.documentTitle,
        content: t.parentContent ?? t.content,
        similarity: similarityOf.get(t.chunkId),
        imageHash: t.metadata?.imageHash ?? null,
      });
    }
    return { matches, chunks, best: matches[0], strong: matches[0].similarity >= strongSimilarity };
  } catch (err) {
    logger.error("[faq] lookup failed (answering from the manuals alone)", err);
    return NONE;
  }
};

/** FAQ passages first, then the retrieved ones, without repeating a passage the search already found. */
export const mergeFaqChunks = (retrieved, faqChunks, maxFaqChunks = 3) => {
  const haveId = new Set(retrieved.map((c) => c.chunkId));
  const haveText = new Set(retrieved.map((c) => c.content));
  const extra = faqChunks.filter((c) => !haveId.has(c.chunkId) && !haveText.has(c.content)).slice(0, maxFaqChunks);
  return [...extra, ...retrieved];
};

/**
 * A technician rated an answer. "Resolved" puts its question in the FAQ; any
 * other rating takes it back out. Only a verified, grounded answer is kept.
 * @returns {Promise<{faq: "added" | "already_known" | "removed" | "skipped", reason?: string}>}
 */
export const recordResolution = async ({ turn, resolution }) => {
  if (resolution !== "resolved") {
    await deactivateFaqOfTurn(turn.turnId);
    return { faq: "removed" };
  }

  const json = turn.turnJson ?? {};
  if (turn.gateOutcome !== "answered") return { faq: "skipped", reason: "not an answer" };
  if (json.verified === false) return { faq: "skipped", reason: "the answer was flagged unverified" };
  if (!json.standalone_question || !Array.isArray(json.source_chunk_ids) || json.source_chunk_ids.length === 0) {
    return { faq: "skipped", reason: "no question or sources were recorded" };
  }

  const embedding = await generateEmbedding(json.standalone_question);
  const { created } = await addFaq({
    question: json.standalone_question,
    answer: turn.text,
    embedding,
    sourceChunkIds: json.source_chunk_ids,
    citations: json.sources ?? [],
    sourceTurnId: turn.turnId,
    dedupeSimilarity: await getFaqDedupeSimilarity(),
  });
  logger.info(`[faq] ${created ? "added" : "already known"}: "${json.standalone_question}"`);
  return { faq: created ? "added" : "already_known" };
};
