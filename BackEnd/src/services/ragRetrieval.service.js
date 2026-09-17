import { prisma } from "../config/prisma.js";
import { generateEmbedding, toVectorLiteral } from "./embedding.service.js";
import { withTiming } from "../utils/timing.js";

const MATCH_COUNT = parseInt(process.env.RAG_MATCH_COUNT || "6", 10);

/**
 * Embeds the question and runs a pgvector cosine-similarity search scoped to
 * customerId. This customer_id filter is applied in the database query
 * itself — never left to the caller/frontend to enforce.
 */
export const retrieveRelevantChunks = async ({ customerId, question }) => {
  const embedding = await generateEmbedding(question);
  const vectorLiteral = toVectorLiteral(embedding);

  const chunks = await withTiming("pgvector similarity search ($queryRaw)", () =>
    prisma.$queryRaw`
      SELECT
        id,
        document_id AS "documentId",
        page_number AS "pageNumber",
        chunk_index AS "chunkIndex",
        content,
        1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM document_chunks
      WHERE customer_id = ${customerId}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${MATCH_COUNT}
    `
  );

  return chunks;
};
