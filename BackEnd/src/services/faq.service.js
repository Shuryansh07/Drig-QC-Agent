import { generateEmbedding } from "./embedding.service.js";
import { getOpenAIClient } from "../config/openaiClient.js";
import { getChunksByIds } from "../db/chunks.js";
import { matchFaq, addFaq, addAdminFaq, deactivateFaqOfTurn, liveChunkIds } from "../db/faq.js";
import {
  getFaqMinSimilarity,
  getFaqMatchCount,
  getFaqStrongSimilarity,
  getFaqDedupeSimilarity,
  getFaqAdminLooseSimilarity,
} from "../db/settings.js";
import { removeAnsweredGaps } from "../db/gaps.js";
import { logger } from "../utils/logger.js";

// The FAQ: questions technicians marked "resolved", kept with the passages that
// answered them. A new question is searched against it as well as the manuals.
//
// An admin can also write an answer for a question the assistant could not answer
// (source "admin"). It has no passages: a match on one IS the reply (resolveAdminAnswer)
// when it is very close, or when it is looser (a keyword query like "jupiter moon count")
// and a small model call agrees it asks the same thing. Otherwise, a match helps in three ways, none of which lets an
// answer rest on the FAQ alone:
//   1. its source passages join the evidence (they are real, live chunks, so
//      citations and the verification checks still work on them);
//   2. its answer is shown to the answer model as a reference, never as evidence;
//   3. a very close match skips the clarification question and can admit a question
//      that retrieval alone would have refused.

const NONE = { matches: [], chunks: [], best: null, strong: false, adminCandidates: [] };

const SAME_QUESTION_MODEL = process.env.OPENAI_FAQ_MATCH_MODEL || process.env.OPENAI_REWRITE_MODEL || "gpt-4o-mini";
const SAME_QUESTION_TIMEOUT_MS = parseInt(process.env.FAQ_MATCH_TIMEOUT_MS || "5000", 10);
/** Admin answers offered to the model at once: the nearest few, so the right one need not be the very nearest. */
const MAX_ADMIN_CANDIDATES = 3;

/** The resolved questions closest to this one, and the live passages that answered them. Never throws. */
export const findFaq = async ({ embedding }) => {
  try {
    const [minSimilarity, count, strongSimilarity, looseSimilarity] = await Promise.all([
      getFaqMinSimilarity(),
      getFaqMatchCount(),
      getFaqStrongSimilarity(),
      getFaqAdminLooseSimilarity(),
    ]);
    // One search, down to the lower of the two bars. Admin answers above the loose bar are candidates for the
    // same-question check; everything else keeps the usual bar, so a loose match never adds passages or a reference.
    const found = await matchFaq(embedding, Math.max(count, MAX_ADMIN_CANDIDATES), Math.min(minSimilarity, looseSimilarity));
    const adminCandidates = found.filter((m) => m.source === "admin" && m.similarity >= looseSimilarity).slice(0, MAX_ADMIN_CANDIDATES);
    const matches = found.filter((m) => m.similarity >= minSimilarity).slice(0, count);
    if (matches.length === 0) return { ...NONE, adminCandidates };

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
        pageLabel: t.pageLabel,
        sectionPath: t.sectionPath,
        documentTitle: t.documentTitle,
        content: t.parentContent ?? t.content,
        similarity: similarityOf.get(t.chunkId),
        imageHash: t.metadata?.imageHash ?? null,
      });
    }
    return { matches, chunks, best: matches[0], strong: matches[0].similarity >= strongSimilarity, adminCandidates };
  } catch (err) {
    logger.error("[faq] lookup failed (answering from the manuals alone)", err);
    return NONE;
  }
};

const SAME_QUESTION_PROMPT = `A technician asked a question. An admin has already written answers to the numbered questions below.
Decide whether one of them asks for the same information, so that its answer would fully and correctly answer the technician.
Return JSON only: {"match": <the number of that question, or null>}

Rules:
- Wording does not matter: a keyword query ("jupiter moon count") can ask the same thing as a full sentence.
- A different subject is a different question: another product or model, another vehicle, another planet, another part, another fault.
- A broader or narrower question is not the same: an answer about installing the SIM does not answer how to install the whole unit.
- When unsure, return {"match": null}.`;

/** Which candidate (by index) asks the same as `question`, per a small model call; null on no, a failure or a timeout. */
const sameQuestionAs = async (question, candidates) => {
  try {
    const list = candidates.map((c, i) => `${i + 1}. ${c.question}`).join("\n");
    const response = await getOpenAIClient().chat.completions.create(
      {
        model: SAME_QUESTION_MODEL,
        messages: [
          { role: "system", content: SAME_QUESTION_PROMPT },
          { role: "user", content: `Technician's question: ${question}\n\nAnswered questions:\n${list}` },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      },
      { signal: AbortSignal.timeout(SAME_QUESTION_TIMEOUT_MS) }
    );
    const match = JSON.parse(response.choices?.[0]?.message?.content ?? "{}").match;
    return Number.isInteger(match) && match >= 1 && match <= candidates.length ? match - 1 : null;
  } catch (err) {
    logger.warn(`[faq] same-question check failed, not using an admin answer: ${err.message}`);
    return null;
  }
};

/**
 * The admin-written answer to give for this question, or null. A very close match is used as it is; a looser
 * admin match (faq.admin_loose_similarity up to faq.strong_similarity) only when a small model call agrees it
 * is the same question. No admin answer in that range means no model call.
 * @returns {Promise<{entry: object, how: "similarity" | "model"} | null>}
 */
export const resolveAdminAnswer = async ({ question, faq }) => {
  if (faq.strong && faq.best?.source === "admin") return { entry: faq.best, how: "similarity" };
  const candidates = faq.adminCandidates ?? [];
  if (candidates.length === 0) return null;
  const index = await sameQuestionAs(question, candidates);
  return index === null ? null : { entry: candidates[index], how: "model" };
};

/**
 * An admin answered a question from the Unanswered questions tab. The question is embedded (same model
 * as the manuals' chunks) and kept in faq_entry, so the next technician asking it gets this answer.
 * The gaps recorded for that question (kb_gap) are then removed: every one close enough to be given
 * this answer on similarity alone (faq.strong_similarity, resolveAdminAnswer's first bar).
 * @returns {Promise<{faqId: string, created: boolean, gapsRemoved: number}>}
 */
export const recordAdminAnswer = async ({ question, answer }) => {
  const embedding = await generateEmbedding(question);
  const [dedupeSimilarity, strongSimilarity] = await Promise.all([getFaqDedupeSimilarity(), getFaqStrongSimilarity()]);
  const result = await addAdminFaq({ question, answer, embedding, dedupeSimilarity });
  // The answer is saved either way; a failure here only leaves the gaps listed.
  const gapsRemoved = await removeAnsweredGaps(embedding, strongSimilarity).catch((err) => {
    logger.error("[faq] admin answer saved, but its gaps could not be removed", err);
    return 0;
  });
  logger.info(`[faq] admin answer ${result.created ? "added" : "updated"}: "${question}" (${gapsRemoved} gap(s) removed)`);
  return { ...result, gapsRemoved };
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
