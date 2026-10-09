import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";
import { toVectorLiteral } from "./vector.js";

// FAQ of resolved questions (migration 0800), searched with match_faq().

export interface FaqMatch {
  faqId: string;
  question: string;
  answer: string;
  sourceChunkIds: string[];
  citations: unknown[];
  similarity: number;
}

export const matchFaq = async (embedding: number[], matchCount: number, minSimilarity: number): Promise<FaqMatch[]> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(`select * from match_faq($1, $2::extensions.vector, $3, $4)`, [
    orgId,
    toVectorLiteral(embedding),
    matchCount,
    minSimilarity,
  ]);
  return rows.map((r: any) => ({
    faqId: r.faq_id,
    question: r.question,
    answer: r.answer,
    sourceChunkIds: r.source_chunk_ids ?? [],
    citations: r.citations ?? [],
    similarity: r.similarity,
  }));
};

/** Adds a resolved question, or — when one this close already exists — just counts it as used again. */
export const addFaq = async (faq: {
  question: string;
  answer: string;
  embedding: number[];
  sourceChunkIds: string[];
  citations: unknown[];
  sourceTurnId: string;
  dedupeSimilarity: number;
}): Promise<{ faqId: string; created: boolean }> => {
  const [nearest] = await matchFaq(faq.embedding, 1, faq.dedupeSimilarity);
  if (nearest) {
    await pool.query(`update faq_entry set times_used = times_used + 1, last_used_at = now(), active = true where faq_id = $1`, [nearest.faqId]);
    return { faqId: nearest.faqId, created: false };
  }
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `insert into faq_entry (org_id, question, answer, embedding, source_chunk_ids, citations, source_turn_id)
     values ($1, $2, $3, $4::extensions.vector, $5::uuid[], $6, $7) returning faq_id`,
    [orgId, faq.question, faq.answer, toVectorLiteral(faq.embedding), faq.sourceChunkIds, JSON.stringify(faq.citations), faq.sourceTurnId]
  );
  return { faqId: rows[0].faq_id, created: true };
};

/** The technician changed their mind: the answer no longer counts as resolved. */
export const deactivateFaqOfTurn = async (turnId: string): Promise<void> => {
  await pool.query(`update faq_entry set active = false where source_turn_id = $1`, [turnId]);
};

export const markFaqUsed = async (faqIds: string[]): Promise<void> => {
  if (faqIds.length === 0) return;
  await pool.query(`update faq_entry set times_used = times_used + 1, last_used_at = now() where faq_id = any($1::uuid[])`, [faqIds]);
};

/** Of these chunk ids, the ones that still exist and are live (a manual may have been replaced since). */
export const liveChunkIds = async (chunkIds: string[]): Promise<string[]> => {
  if (chunkIds.length === 0) return [];
  const { rows } = await pool.query(`select chunk_id from kb_chunk where chunk_id = any($1::uuid[]) and is_live`, [chunkIds]);
  return rows.map((r: any) => r.chunk_id);
};
