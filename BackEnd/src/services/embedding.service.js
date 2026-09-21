import { getOpenAIClient } from "../config/openaiClient.js";
import { withTiming } from "../utils/timing.js";
import { embeddingLimiter } from "../utils/concurrencyLimiter.js";
import { retryWithBackoff } from "../utils/retry.js";
import { toVectorLiteral as vectorLiteral, EMBEDDING_DIMENSIONS as VECTOR_DIMENSIONS } from "../db/vector.js";

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_TIMEOUT_MS = parseInt(process.env.EMBEDDING_TIMEOUT_MS || "30000", 10);
// Same reasoning as VISION_MAX_RETRIES in vision.service.js — a sustained
// per-minute rate limit can outlast the OpenAI SDK's own short retry window.
const EMBEDDING_MAX_RETRIES = parseInt(process.env.EMBEDDING_MAX_RETRIES || "5", 10);
// Defensive cap, not the primary batching mechanism — a page's chunk count
// rarely approaches this. If it ever did, split into multiple batched calls
// rather than one unbounded request.
const EMBEDDING_BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || "20", 10);

// Must match the pgvector column dimension (vector(1536) in db/migrations).
// If you change OPENAI_EMBEDDING_MODEL to one with a different output size,
// update EMBEDDING_DIMENSIONS *and* run a migration to alter the column/index.
export const EMBEDDING_DIMENSIONS = VECTOR_DIMENSIONS;

const validate = (embedding, index) => {
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch at index ${index}: expected ${EMBEDDING_DIMENSIONS}, got ${embedding?.length ?? "none"}. ` +
        `Check EMBEDDING_DIMENSIONS against the output size of OPENAI_EMBEDDING_MODEL ("${EMBEDDING_MODEL}").`
    );
  }
};

/**
 * Batch-embeds multiple texts in a single OpenAI API call (the embeddings
 * endpoint natively accepts an array `input`) instead of one request per
 * chunk. Splits into EMBEDDING_BATCH_SIZE-sized requests if given more texts
 * than that (defensive — a single page rarely produces this many chunks).
 * Returns vectors in the same order as `texts`.
 */
export const generateEmbeddings = async (texts) => {
  const nonEmpty = texts.filter((t) => t && t.trim());
  if (nonEmpty.length !== texts.length) {
    throw new Error("Cannot generate embeddings for empty content");
  }
  if (texts.length === 0) return [];

  const client = getOpenAIClient();
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);

    const response = await retryWithBackoff(
      `Embeddings batch (${batch.length} text(s))`,
      () =>
        embeddingLimiter(() =>
          withTiming(`OpenAI embeddings.create (${EMBEDDING_MODEL}, batch of ${batch.length})`, () =>
            client.embeddings.create(
              { model: EMBEDDING_MODEL, input: batch },
              { timeout: EMBEDDING_TIMEOUT_MS }
            )
          )
        ),
      { maxRetries: EMBEDDING_MAX_RETRIES, baseDelayMs: 2000 }
    );

    const embeddings = response.data?.map((d) => d.embedding) ?? [];

    if (embeddings.length !== batch.length) {
      throw new Error(`Embedding batch size mismatch: sent ${batch.length}, got back ${embeddings.length}`);
    }
    embeddings.forEach(validate);
    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
};

/** Single-text convenience wrapper around generateEmbeddings — used for query-time question embedding. */
export const generateEmbedding = async (text) => {
  const [embedding] = await generateEmbeddings([text]);
  return embedding;
};

// pgvector text input format for casting a parameter to ::vector in raw SQL.
// Delegates to src/db/vector.ts (the single place this is implemented) so
// the dimension assertion always runs.
export const toVectorLiteral = vectorLiteral;
