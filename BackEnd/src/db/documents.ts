import { pool } from "./pool.js";
import { getDefaultOrg, getUploadSourceId } from "./org.js";

export type IngestStatus =
  | "queued"
  | "processing"
  | "rag_processing"
  | "rag_completed"
  | "workdrive_uploading"
  | "completed"
  | "completed_with_errors"
  | "failed";

export interface DocumentRecord {
  docId: string;
  title: string;
  contentHash: string | null;
  externalRef: string | null;
  liveVersion: number;
  ingestStatus: IngestStatus;
  tempFilePath: string | null;
  pageCount: number | null;
  processedPages: number | null;
  failedPages: number | null;
  errorMessage: string | null;
  workdriveFolderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const mapRow = (r: any): DocumentRecord => ({
  docId: r.doc_id,
  title: r.title,
  contentHash: r.content_hash,
  externalRef: r.external_ref,
  liveVersion: r.live_version,
  ingestStatus: r.ingest_status,
  tempFilePath: r.temp_file_path,
  pageCount: r.page_count,
  processedPages: r.processed_pages,
  failedPages: r.failed_pages,
  errorMessage: r.error_message,
  workdriveFolderId: r.workdrive_folder_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SELECT = `
  select d.doc_id, d.title, d.content_hash, d.external_ref, d.live_version, d.created_at,
         s.ingest_status, s.temp_file_path, s.page_count, s.processed_pages, s.failed_pages,
         s.error_message, s.workdrive_folder_id, s.updated_at
    from kb_document d
    join kb_document_ingest_state s on s.doc_id = d.doc_id
`;

export interface DocumentSummary extends DocumentRecord {
  /** Heading sections (parent chunks): what the answer model reads. */
  parentChunks: number;
  /** Retrieval chunks (children): what search matches. */
  childChunks: number;
}

export interface DocumentPage {
  documents: DocumentSummary[];
  /** Total rows matching the filter, across every page — not just this one. */
  total: number;
}

/** Escapes ILIKE's own wildcards so a title containing a literal `%` or `_` is matched literally, not as a pattern. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Newest first, offset-paginated, optionally filtered to titles containing
 * `search` (case-insensitive substring). Uploaded documents only; counts
 * cover the current (unsuperseded-by-a-newer-version) chunks. Two queries
 * rather than one with count(*) over(): a page past the end (e.g. the admin
 * deleted the last document on the last page and hasn't refetched yet) would
 * return zero rows and so zero total from a window function, which is wrong
 * — the count query always reflects the real total regardless of which page
 * is empty.
 */
export const listDocuments = async (page = 1, pageSize = 10, search?: string): Promise<DocumentPage> => {
  const { orgId } = await getDefaultOrg();
  const offset = (page - 1) * pageSize;
  const trimmed = search?.trim();

  // Built once and reused for both queries, so the row set a page is sliced
  // from and the total it's sliced out of can never drift apart from each other.
  const baseParams: unknown[] = [orgId];
  let titleFilter = "";
  if (trimmed) {
    baseParams.push(`%${escapeLike(trimmed)}%`);
    titleFilter = ` and d.title ilike $${baseParams.length} escape '\\'`;
  }

  const [{ rows }, {
    rows: [{ count }],
  }] = await Promise.all([
    pool.query(
      `select d.doc_id, d.title, d.content_hash, d.external_ref, d.live_version, d.created_at,
              s.ingest_status, s.temp_file_path, s.page_count, s.processed_pages, s.failed_pages,
              s.error_message, s.workdrive_folder_id, s.updated_at,
              (select count(*) from kb_chunk c where c.doc_id = d.doc_id and c.deleted_at is null and c.is_parent) as parent_chunks,
              (select count(*) from kb_chunk c where c.doc_id = d.doc_id and c.deleted_at is null and not c.is_parent) as child_chunks
         from kb_document d
         join kb_document_ingest_state s on s.doc_id = d.doc_id
        where d.org_id = $1 and d.origin = 'upload'${titleFilter}
        order by d.created_at desc
        limit $${baseParams.length + 1} offset $${baseParams.length + 2}`,
      [...baseParams, pageSize, offset]
    ),
    pool.query(
      `select count(*) from kb_document d where d.org_id = $1 and d.origin = 'upload'${titleFilter}`,
      baseParams
    ),
  ]);

  return {
    documents: rows.map((r) => ({
      ...mapRow(r),
      parentChunks: parseInt(r.parent_chunks, 10),
      childChunks: parseInt(r.child_chunks, 10),
    })),
    total: parseInt(count, 10),
  };
};

/**
 * Titles of documents that are live and searchable. Shown when a question isn't
 * covered, so the technician learns the boundary of what the assistant knows
 * (NotCoveredInfo.coveredTopics) instead of just being told "no".
 */
export const listLiveDocumentTitles = async (limit = 8): Promise<string[]> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query<{ title: string }>(
    `select title from kb_document
      where org_id = $1 and status = 'current' and live_version > 0
      order by title
      limit $2`,
    [orgId, limit]
  );
  return rows.map((r) => r.title.replace(/\.(pdf|docx)$/i, ""));
};

export const findByContentHash = async (contentHash: string): Promise<DocumentRecord | null> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `${SELECT} where d.org_id = $1 and d.content_hash = $2
       and s.ingest_status in ('completed', 'completed_with_errors')
     order by d.created_at desc
     limit 1`,
    [orgId, contentHash]
  );
  return rows[0] ? mapRow(rows[0]) : null;
};

export const findById = async (docId: string): Promise<DocumentRecord | null> => {
  const { rows } = await pool.query(`${SELECT} where d.doc_id = $1`, [docId]);
  return rows[0] ? mapRow(rows[0]) : null;
};

export const createDocument = async ({
  title,
  contentHash,
  tempFilePath,
}: {
  title: string;
  contentHash: string;
  tempFilePath: string;
}): Promise<DocumentRecord> => {
  const { orgId } = await getDefaultOrg();
  const sourceId = await getUploadSourceId();

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: docRows } = await client.query(
      `insert into kb_document (org_id, source_id, external_ref, title, content_hash, origin, sync_state)
       values ($1, $2, $3, $4, $5, 'upload', 'fetched')
       returning doc_id`,
      [orgId, sourceId, `upload:${title}:${Date.now()}`, title, contentHash]
    );
    const docId = docRows[0].doc_id;

    await client.query(
      `insert into kb_document_ingest_state (doc_id, ingest_status, temp_file_path)
       values ($1, 'queued', $2)`,
      [docId, tempFilePath]
    );
    await client.query("commit");

    const created = await findById(docId);
    if (!created) throw new Error("Failed to read back created document");
    return created;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
};

export const updateIngestState = async (
  docId: string,
  fields: Partial<{
    ingestStatus: IngestStatus;
    tempFilePath: string | null;
    pageCount: number;
    processedPages: number;
    failedPages: number;
    errorMessage: string | null;
    workdriveFolderId: string | null;
    externalRef: string | null;
  }>
): Promise<void> => {
  const sets: string[] = [];
  const values: unknown[] = [docId];
  let i = 2;

  const columnMap: Record<string, string> = {
    ingestStatus: "ingest_status",
    tempFilePath: "temp_file_path",
    pageCount: "page_count",
    processedPages: "processed_pages",
    failedPages: "failed_pages",
    errorMessage: "error_message",
    workdriveFolderId: "workdrive_folder_id",
  };

  for (const [key, col] of Object.entries(columnMap)) {
    if (key in fields) {
      sets.push(`${col} = $${i}`);
      values.push((fields as any)[key]);
      i++;
    }
  }

  if (sets.length > 0) {
    await pool.query(
      `update kb_document_ingest_state set ${sets.join(", ")}, updated_at = now() where doc_id = $1`,
      values
    );
  }

  if ("externalRef" in fields) {
    await pool.query(`update kb_document set external_ref = $2 where doc_id = $1`, [docId, fields.externalRef]);
  }
};

const IN_FLIGHT_STATUSES: IngestStatus[] = ["queued", "processing", "rag_processing", "workdrive_uploading"];

export class DocumentBusyError extends Error {
  status = 409;
}

export interface DeletedDocument {
  title: string;
  externalRef: string | null;
  tempFilePath: string | null;
  chunks: number;
  images: number;
}

/**
 * Hard-deletes a document and everything derived from it — chunks (and so their
 * vectors), figures, page progress, jobs — in one transaction. Returns null when
 * the document does not exist. Refuses while the worker may be using it.
 *
 * Rows that only mention the chunks (citations, retrieval logs) keep their place
 * with the chunk reference cleared, so conversation history survives; wiring
 * rows keep their data with the document link cleared.
 */
export const deleteDocumentData = async (docId: string): Promise<DeletedDocument | null> => {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const { rows } = await client.query(
      `select d.org_id, d.title, d.external_ref, s.ingest_status, s.temp_file_path
         from kb_document d
         join kb_document_ingest_state s on s.doc_id = d.doc_id
        where d.doc_id = $1
          for update of d, s`,
      [docId]
    );
    const doc = rows[0];
    if (!doc) {
      await client.query("rollback");
      return null;
    }
    if (IN_FLIGHT_STATUSES.includes(doc.ingest_status)) {
      throw new DocumentBusyError(`Document is currently ${doc.ingest_status} — wait for it to finish before deleting it`);
    }

    const chunkIds = `select chunk_id from kb_chunk where doc_id = $1`;
    await client.query(`update citation set chunk_id = null where chunk_id in (${chunkIds})`, [docId]);
    await client.query(`update turn_retrieval set chunk_id = null where chunk_id in (${chunkIds})`, [docId]);
    await client.query(`delete from kb_conflict where chunk_id_a in (${chunkIds}) or chunk_id_b in (${chunkIds})`, [docId]);
    const images = await client.query(`delete from kb_image where doc_id = $1`, [docId]);
    const chunks = await client.query(`delete from kb_chunk where doc_id = $1`, [docId]);
    await client.query(`delete from kb_document_page where doc_id = $1`, [docId]);
    await client.query(`delete from ingestion_job where doc_id = $1`, [docId]);
    await client.query(`update wiring_entry set doc_id = null where doc_id = $1`, [docId]);
    await client.query(`update kb_document set supersedes_doc_id = null where supersedes_doc_id = $1`, [docId]);
    await client.query(`delete from kb_document_ingest_state where doc_id = $1`, [docId]);
    await client.query(`delete from kb_document where doc_id = $1`, [docId]);
    await client.query(`insert into event_log (org_id, event_type, payload) values ($1, 'document.deleted', $2::jsonb)`, [
      doc.org_id,
      JSON.stringify({ doc_id: docId, title: doc.title, chunks: chunks.rowCount, images: images.rowCount }),
    ]);

    await client.query("commit");
    return {
      title: doc.title,
      externalRef: doc.external_ref,
      tempFilePath: doc.temp_file_path,
      chunks: chunks.rowCount ?? 0,
      images: images.rowCount ?? 0,
    };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
};
