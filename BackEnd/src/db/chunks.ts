import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";
import { toVectorLiteral } from "./vector.js";
import crypto from "node:crypto";

export interface ChunkInput {
  pageNumber: number;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

/**
 * Upserts chunks for a document version. version is fixed at 1 here — this
 * pipeline doesn't yet implement re-sync-with-reuse (DATABASE.md §7 step 2,
 * "reuse the stored vector for unchanged text_hash"); every (re)ingest
 * replaces version 1's chunks for the pages it touches.
 */
export const upsertChunks = async (docId: string, chunks: ChunkInput[]): Promise<void> => {
  if (chunks.length === 0) return;
  const { orgId } = await getDefaultOrg();

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const chunk of chunks) {
      const textHash = crypto.createHash("sha256").update(chunk.content).digest("hex");
      await client.query(
        `insert into kb_chunk
           (org_id, doc_id, version, text, text_hash, embedding, source_type,
            page_from, page_to, chunk_index, metadata)
         values ($1, $2, 1, $3, $4, $5::extensions.vector, 'upload', $6, $6, $7, $8)
         on conflict (doc_id, page_from, chunk_index) where chunk_index is not null
         do update set text = excluded.text, text_hash = excluded.text_hash,
                        embedding = excluded.embedding, metadata = excluded.metadata`,
        [
          orgId,
          docId,
          chunk.content,
          textHash,
          toVectorLiteral(chunk.embedding),
          chunk.pageNumber,
          chunk.chunkIndex,
          JSON.stringify(chunk.metadata ?? {}),
        ]
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
};

export const countChunks = async (docId: string): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(`select count(*)::text as count from kb_chunk where doc_id = $1`, [docId]);
  return parseInt(rows[0].count, 10);
};

export interface ChunkText {
  chunkId: string;
  docId: string;
  pageFrom: number | null;
  content: string;
}

/**
 * match_chunks() returns ids + rank/similarity only, never chunk text (rule
 * P5 keeps vector queries in their own function; this is a plain by-id
 * fetch, not a similarity query, so it's a separate, ordinary lookup).
 */
export const getChunksByIds = async (chunkIds: string[]): Promise<ChunkText[]> => {
  if (chunkIds.length === 0) return [];
  const { rows } = await pool.query(
    `select chunk_id, doc_id, page_from, text from kb_chunk where chunk_id = any($1)`,
    [chunkIds]
  );
  return rows.map((r) => ({ chunkId: r.chunk_id, docId: r.doc_id, pageFrom: r.page_from, content: r.text }));
};

export const countChunksForPage = async (docId: string, pageNumber: number): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from kb_chunk where doc_id = $1 and page_from = $2`,
    [docId, pageNumber]
  );
  return parseInt(rows[0].count, 10);
};
