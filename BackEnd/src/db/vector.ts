// Must match the pgvector column dimension (vector(1536) in db/migrations).
// Changing the embedding model means new columns or a full re-embed (§8.10).
export const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10);

/**
 * Serialises a raw embedding for a ::vector cast in a parameterised query.
 * This is the ONLY place an embedding array becomes pgvector's text input
 * format — every caller goes through here so the dimension assertion always
 * runs (rule P5's spirit: catch a mismatched embedding model before it
 * silently corrupts a column).
 */
export const toVectorLiteral = (embedding: number[]): string => {
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding has ${embedding?.length ?? "no"} dimensions, expected ${EMBEDDING_DIMENSIONS}. ` +
        "Check EMBEDDING_DIMENSIONS against the configured embedding model's output size."
    );
  }
  return `[${embedding.join(",")}]`;
};
