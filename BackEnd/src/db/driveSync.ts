import { pool } from "./pool.js";

// Persistent side of the Drive sync (see migration 0780): a run per sync and a
// ledger row per Drive file, which is what lets a stopped sync resume.

export interface LedgerFile {
  id: string;
  name: string;
  folder: string;
  type: string;
  modifiedTime: string | null;
}

export interface LedgerRow {
  file_id: string;
  modified_time: string | null;
  status: "waiting" | "downloading" | "queued" | "duplicate" | "failed";
}

export const listLedger = async (): Promise<LedgerRow[]> =>
  (await pool.query(`select file_id, modified_time, status from drive_sync_file`)).rows;

export const createRun = async (trigger: string, found: number, total: number): Promise<number> =>
  Number((await pool.query(`insert into drive_sync_run (trigger, found, total) values ($1, $2, $3) returning id`, [trigger, found, total])).rows[0].id);

/** Puts the files in the ledger as "waiting" under this run, in order (new or changed ones, and ones to retry). */
export const assignFilesToRun = async (runId: number, files: LedgerFile[]): Promise<void> => {
  if (files.length === 0) return;
  await pool.query(
    `insert into drive_sync_file (file_id, name, folder, type, modified_time, status, doc_id, message, run_id, seq, updated_at)
     select f.id, f.name, f.folder, f.type, f.modified_time, 'waiting', null, null, $1, f.seq, now()
       from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[])
            as f(id, name, folder, type, modified_time, seq)
     on conflict (file_id) do update
        set name = excluded.name, folder = excluded.folder, type = excluded.type,
            modified_time = excluded.modified_time, status = 'waiting', doc_id = null,
            message = null, run_id = excluded.run_id, seq = excluded.seq, updated_at = now()`,
    [
      runId,
      files.map((f) => f.id),
      files.map((f) => f.name),
      files.map((f) => f.folder),
      files.map((f) => f.type),
      files.map((f) => f.modifiedTime),
      files.map((_, i) => i),
    ]
  );
};

export const setFileState = async (
  fileId: string,
  state: { status: LedgerRow["status"]; docId?: string | null; message?: string | null }
): Promise<void> => {
  await pool.query(
    `update drive_sync_file set status = $2, doc_id = $3, message = $4, updated_at = now() where file_id = $1`,
    [fileId, state.status, state.docId ?? null, state.message ?? null]
  );
};

export const updateRun = async (
  runId: number,
  patch: Partial<{
    processed: number;
    queued: number;
    duplicates: number;
    failed: number;
    currentFile: string | null;
    error: string | null;
    stopped: boolean;
    finished: boolean;
  }>
): Promise<void> => {
  await pool.query(
    `update drive_sync_run set
        processed    = coalesce($2, processed),
        queued       = coalesce($3, queued),
        duplicates   = coalesce($4, duplicates),
        failed       = coalesce($5, failed),
        current_file = case when $6::boolean then $7 else current_file end,
        error        = coalesce($8, error),
        stopped      = coalesce($9, stopped),
        finished_at  = case when $10::boolean then now() else finished_at end
      where id = $1`,
    [
      runId,
      patch.processed ?? null,
      patch.queued ?? null,
      patch.duplicates ?? null,
      patch.failed ?? null,
      "currentFile" in patch,
      patch.currentFile ?? null,
      patch.error ?? null,
      patch.stopped ?? null,
      patch.finished ?? false,
    ]
  );
};

/** Stop: files whose job was cancelled go back to "waiting", so the next sync sends them again. */
export const requeueFilesOfDocs = async (docIds: string[]): Promise<void> => {
  if (docIds.length === 0) return;
  await pool.query(
    `update drive_sync_file set status = 'waiting', doc_id = null, message = 'Stopped before it finished', updated_at = now()
      where doc_id = any($1::uuid[])`,
    [docIds]
  );
};

/** After a backend restart: a sync that was running cannot be; its half-done files wait for the next one. */
export const recoverInterruptedRuns = async (): Promise<void> => {
  await pool.query(`update drive_sync_file set status = 'waiting', message = 'Interrupted by a restart', updated_at = now() where status = 'downloading'`);
  await pool.query(
    `update drive_sync_run set finished_at = now(), stopped = true, current_file = null,
            error = coalesce(error, 'Interrupted by a backend restart; Sync resumes it')
      where finished_at is null`
  );
};

export const countResumable = async (): Promise<number> =>
  (await pool.query(`select count(*)::int as n from drive_sync_file where status in ('waiting','failed')`)).rows[0].n;

/** The latest syncs, newest first, each with the files it took on. */
export const listRuns = async (limit: number) => {
  const runs = (await pool.query(`select * from drive_sync_run order by id desc limit $1`, [limit])).rows;
  if (runs.length === 0) return [];
  const files = (
    await pool.query(
      `select run_id, name, folder, type, status, doc_id, message
         from drive_sync_file where run_id = any($1::bigint[]) order by run_id, seq`,
      [runs.map((r: any) => r.id)]
    )
  ).rows;
  return runs.map((r: any) => ({
    id: Number(r.id),
    trigger: r.trigger,
    started_at: r.started_at.toISOString(),
    finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    found: r.found,
    total: r.total,
    processed: r.processed,
    queued: r.queued,
    duplicates: r.duplicates,
    failed: r.failed,
    current: r.current_file,
    error: r.error,
    stopped: r.stopped,
    files: files
      .filter((f: any) => Number(f.run_id) === Number(r.id))
      .map((f: any) => ({ name: f.name, folder: f.folder, type: f.type, status: f.status, document_id: f.doc_id, message: f.message })),
  }));
};
