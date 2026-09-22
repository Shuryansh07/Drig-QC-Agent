import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";
import { toVectorLiteral } from "./vector.js";
import crypto from "node:crypto";
import { stripNul, safeJson } from "../utils/sanitize.js";

// Parent/child chunk storage (db/migrations/20260921000730_parent_child_chunks.sql).
//   parent = a heading section: full text, never embedded, never live. Read by id.
//   child  = a small retrieval unit: embedded, keyword-indexed, made live only by
//            publish_document_version().
// Chunk identity is (doc_id, version, page_from, chunk_index).

export interface ParentInput {
  key: string;
  chunkIndex: number;
  sectionPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  text: string;
  metadata: Record<string, unknown>;
}

export interface ChildInput {
  parentKey: string;
  chunkIndex: number;
  sectionPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  text: string;
  metadata: Record<string, unknown>;
  /** pgvector text form ("[0.1,...]") as read back from the DB, or a fresh embedding. */
  embedding: number[] | string;
}

// Hash of the NUL-stripped text: that is what is stored, and what a later run looks up.
export const hashText = (text: string): string => crypto.createHash("sha256").update(stripNul(text)).digest("hex");

const asVectorLiteral = (embedding: number[] | string): string =>
  typeof embedding === "string" ? embedding : toVectorLiteral(embedding);

/**
 * Vectors already computed for identical child text (DATABASE.md §7 step 2:
 * "reuse the stored vector instead of calling the embedding API"). Covers every
 * version of the document, so a retry after a partial failure, or a re-run of
 * an unchanged PDF, only pays for text it has not embedded before. Only vectors
 * from the same embedding model are reused (§8.10).
 */
export const loadReusableEmbeddings = async (docId: string, embeddingModel: string): Promise<Map<string, string>> => {
  const { rows } = await pool.query<{ text_hash: string; embedding: string }>(
    `select distinct on (text_hash) text_hash, embedding::text as embedding
       from kb_chunk
      where doc_id = $1 and not is_parent and embedding is not null
        and metadata ->> 'embedding_model' = $2`,
    [docId, embeddingModel]
  );
  return new Map(rows.map((r) => [r.text_hash, r.embedding]));
};

/**
 * Removes the rows of a version that never went live (a failed or interrupted
 * earlier attempt at the same version). Live and soft-deleted rows are kept:
 * old conversations cite them (INV-7).
 */
export const clearUnpublishedVersion = async (docId: string, version: number): Promise<void> => {
  await pool.query(`delete from kb_chunk where doc_id = $1 and version = $2 and not is_live and deleted_at is null`, [docId, version]);
};

/** Inserts parents and returns chunk_id by the chunker's parent key. */
export const insertParents = async (docId: string, version: number, parents: ParentInput[]): Promise<Map<string, string>> => {
  const idByKey = new Map<string, string>();
  if (parents.length === 0) return idByKey;
  const { orgId } = await getDefaultOrg();

  const { rows } = await pool.query<{ chunk_id: string; chunk_index: number }>(
    `insert into kb_chunk
       (org_id, doc_id, version, text, text_hash, source_type, section_path, page_from, page_to, chunk_index, metadata, is_parent)
     select $1, $2, $3, t.text, t.hash, 'upload', t.section, t.pf, t.pt, t.idx, t.meta::jsonb, true
       from unnest($4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::int[], $10::text[])
            as t(text, hash, section, pf, pt, idx, meta)
     returning chunk_id, chunk_index`,
    [
      orgId,
      docId,
      version,
      parents.map((p) => stripNul(p.text)),
      parents.map((p) => hashText(p.text)),
      parents.map((p) => stripNul(p.sectionPath)),
      parents.map((p) => p.pageFrom),
      parents.map((p) => p.pageTo),
      parents.map((p) => p.chunkIndex),
      parents.map((p) => safeJson(p.metadata)),
    ]
  );

  const keyByIndex = new Map(parents.map((p) => [p.chunkIndex, p.key]));
  for (const row of rows) idByKey.set(keyByIndex.get(row.chunk_index)!, row.chunk_id);
  return idByKey;
};

/** Inserts embedded children under their parents. Not live until publish_document_version(). */
export const insertChildren = async (
  docId: string,
  version: number,
  children: ChildInput[],
  parentIdByKey: Map<string, string>
): Promise<void> => {
  if (children.length === 0) return;
  const { orgId } = await getDefaultOrg();

  const parentIds = children.map((c) => {
    const id = parentIdByKey.get(c.parentKey);
    if (!id) throw new Error(`insertChildren: no stored parent for key "${c.parentKey}"`);
    return id;
  });

  await pool.query(
    `insert into kb_chunk
       (org_id, doc_id, parent_chunk_id, version, text, text_hash, embedding, source_type,
        section_path, page_from, page_to, chunk_index, metadata)
     select $1, $2, t.parent_id, $3, t.text, t.hash, t.emb::extensions.vector, 'upload',
            t.section, t.pf, t.pt, t.idx, t.meta::jsonb
       from unnest($4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::int[], $11::int[], $12::text[])
            as t(parent_id, text, hash, emb, section, pf, pt, idx, meta)`,
    [
      orgId,
      docId,
      version,
      parentIds,
      children.map((c) => stripNul(c.text)),
      children.map((c) => hashText(c.text)),
      children.map((c) => asVectorLiteral(c.embedding)),
      children.map((c) => stripNul(c.sectionPath)),
      children.map((c) => c.pageFrom),
      children.map((c) => c.pageTo),
      children.map((c) => c.chunkIndex),
      children.map((c) => safeJson(c.metadata)),
    ]
  );
};

/** Retrievable chunks (children / standalone) for a document, live or pending publish. */
export const countChunks = async (docId: string): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from kb_chunk where doc_id = $1 and deleted_at is null and not is_parent`,
    [docId]
  );
  return parseInt(rows[0].count, 10);
};

export interface ChunkText {
  chunkId: string;
  docId: string;
  pageFrom: number | null;
  sectionPath: string | null;
  documentTitle: string;
  /** The matched chunk's own text (a child). */
  content: string;
  parentChunkId: string | null;
  /** The parent section's full text, when the chunk has a parent. This is what the answer model reads. */
  parentContent: string | null;
}

/**
 * match_chunks() returns ids + rank/similarity only, never chunk text (rule
 * P5 keeps vector queries in their own function; this is a plain by-id
 * fetch, not a similarity query, so it's a separate, ordinary lookup). The
 * parent is joined here: the child was only the match (DATABASE.md §6.1).
 */
export const getChunksByIds = async (chunkIds: string[]): Promise<ChunkText[]> => {
  if (chunkIds.length === 0) return [];
  const { rows } = await pool.query(
    `select c.chunk_id, c.doc_id, c.page_from, c.section_path, c.text, c.parent_chunk_id, p.text as parent_text,
            d.title as document_title
       from kb_chunk c
       join kb_document d on d.doc_id = c.doc_id
       left join kb_chunk p on p.chunk_id = c.parent_chunk_id
      where c.chunk_id = any($1)`,
    [chunkIds]
  );
  return rows.map((r) => ({
    chunkId: r.chunk_id,
    docId: r.doc_id,
    pageFrom: r.page_from,
    sectionPath: r.section_path,
    documentTitle: r.document_title,
    content: r.text,
    parentChunkId: r.parent_chunk_id,
    parentContent: r.parent_text,
  }));
};
