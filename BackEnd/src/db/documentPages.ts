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

export const updatePage = async (
  id: string,
  fields: Partial<{
    status: string;
    retryCount: number;
    lastError: string | null;
    hasVisual: boolean | null;
    embeddingCompleted: boolean;
    startedAt: Date;
    completedAt: Date;
  }>
): Promise<void> => {
  const columnMap: Record<string, string> = {
    status: "status",
    retryCount: "retry_count",
    lastError: "last_error",
    hasVisual: "has_visual",
    embeddingCompleted: "embedding_completed",
    startedAt: "started_at",
    completedAt: "completed_at",
  };

  const sets: string[] = [];
  const values: unknown[] = [id];
  let i = 2;
  for (const [key, col] of Object.entries(columnMap)) {
    if (key in fields) {
      sets.push(`${col} = $${i}`);
      values.push((fields as any)[key]);
      i++;
    }
  }
  if (sets.length === 0) return;

  await pool.query(`update kb_document_page set ${sets.join(", ")}, updated_at = now() where id = $1`, values);
};

/** Convenience for the "retry attempts" increment the old code did via Prisma's `{ increment: 1 }`. */
export const incrementRetryCount = async (id: string, lastError: string): Promise<void> => {
  await pool.query(
    `update kb_document_page set status = 'failed', retry_count = retry_count + 1, last_error = $2, updated_at = now() where id = $1`,
    [id, lastError]
  );
};
