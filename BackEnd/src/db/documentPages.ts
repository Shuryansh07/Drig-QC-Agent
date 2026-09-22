import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";

export interface DocumentPageRecord {
  id: string;
  docId: string;
  pageNumber: number;
  status: string;
  retryCount: number;
  lastError: string | null;
  hasVisual: boolean | null;
  embeddingCompleted: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
}

const mapRow = (r: any): DocumentPageRecord => ({
  id: r.id,
  docId: r.doc_id,
  pageNumber: r.page_number,
  status: r.status,
  retryCount: r.retry_count,
  lastError: r.last_error,
  hasVisual: r.has_visual,
  embeddingCompleted: r.embedding_completed,
  startedAt: r.started_at,
  completedAt: r.completed_at,
});

/** Upsert-only — leaves existing progress untouched, same as the old Prisma upsert with `update: {}`. */
export const ensurePages = async (docId: string, pageNumbers: number[]): Promise<void> => {
  if (pageNumbers.length === 0) return;
  const { orgId } = await getDefaultOrg();

  await pool.query(
    `insert into kb_document_page (org_id, doc_id, page_number, status)
     select $1, $2, n, 'pending' from unnest($3::int[]) as n
     on conflict (doc_id, page_number) do nothing`,
    [orgId, docId, pageNumbers]
  );
};

export const findPagesByDoc = async (docId: string): Promise<DocumentPageRecord[]> => {
  const { rows } = await pool.query(`select * from kb_document_page where doc_id = $1 order by page_number`, [docId]);
  return rows.map(mapRow);
};

/**
 * Start of an ingestion run. A run rebuilds the whole document version (the
 * chunk plan spans pages, so pages can't be redone one at a time), so every
 * page goes back to 'processing' — one statement, not one per page.
 */
export const resetPagesForRun = async (docId: string, pages: { pageNumber: number; hasVisual: boolean }[]): Promise<void> => {
  if (pages.length === 0) return;
  await pool.query(
    `update kb_document_page p
        set status = 'processing', embedding_completed = false, last_error = null,
            has_visual = v.has_visual, started_at = now(), completed_at = null, updated_at = now()
       from unnest($2::int[], $3::boolean[]) as v(page_number, has_visual)
      where p.doc_id = $1 and p.page_number = v.page_number`,
    [docId, pages.map((p) => p.pageNumber), pages.map((p) => p.hasVisual)]
  );
};

/** A page is complete once every chunk that starts on it is stored. */
export const completePages = async (docId: string, pageNumbers: number[]): Promise<void> => {
  if (pageNumbers.length === 0) return;
  await pool.query(
    `update kb_document_page
        set status = 'completed', embedding_completed = true, completed_at = now(), updated_at = now()
      where doc_id = $1 and page_number = any($2::int[])`,
    [docId, pageNumbers]
  );
};

export const failPages = async (docId: string, pageNumbers: number[], lastError: string): Promise<void> => {
  if (pageNumbers.length === 0) return;
  await pool.query(
    `update kb_document_page
        set status = 'failed', retry_count = retry_count + 1, last_error = $3, updated_at = now()
      where doc_id = $1 and page_number = any($2::int[])`,
    [docId, pageNumbers, lastError.slice(0, 500)]
  );
};
