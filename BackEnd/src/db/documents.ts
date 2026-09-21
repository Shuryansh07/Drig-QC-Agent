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
