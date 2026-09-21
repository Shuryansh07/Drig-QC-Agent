import { generateEmbedding } from "./embedding.service.js";
import { matchChunks } from "../db/retrieval.js";
import { getChunksByIds } from "../db/chunks.js";
import { getDefaultOrg } from "../db/org.js";
import { getRetrievalMatchCount } from "../db/settings.js";
import { withTiming } from "../utils/timing.js";

/**
 * Embeds the question, runs match_chunks() (rule P5 — no raw `<=>` here),
 * then fetches the matched chunks' text by id. match_chunks only ever
 * returns is_live chunks for the current org (tenancy + liveness are hard
 * filters inside the function itself, not applied by the caller).
 */
export const retrieveRelevantChunks = async ({ question }) => {
  const { orgId } = await getDefaultOrg();
  const embedding = await generateEmbedding(question);
  const matchCount = await getRetrievalMatchCount();

  const matches = await withTiming("match_chunks()", () =>
    matchChunks({ orgId, queryEmbedding: embedding, queryText: question, matchCount })
  );

  if (matches.length === 0) return [];

  const texts = await getChunksByIds(matches.map((m) => m.chunkId));
  const textByChunkId = new Map(texts.map((t) => [t.chunkId, t]));

  return matches
    .map((m) => {
      const text = textByChunkId.get(m.chunkId);
      if (!text) return null;
      return {
        chunkId: m.chunkId,
        documentId: m.docId,
        pageNumber: text.pageFrom,
        content: text.content,
        similarity: m.denseSimilarity,
      };
    })
    .filter(Boolean);
};
