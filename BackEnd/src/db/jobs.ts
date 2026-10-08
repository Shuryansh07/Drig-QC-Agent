import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";

// Ops-layer job queue (see db/migrations/20260921000700_ingestion_ops.sql).
// Additive to Plan/DATABASE.md's schema — see that migration's header for
// why. Same FOR UPDATE SKIP LOCKED claim pattern as the old Prisma-backed
// `jobs` table this replaces, now pointed at kb_document(doc_id).

export interface IngestionJob {
  id: string;
  jobType: string;
  docId: string | null;
  pageNumber: number | null;
  payload: unknown;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const mapRow = (r: any): IngestionJob => ({
  id: r.id,
  jobType: r.job_type,
  docId: r.doc_id,
  pageNumber: r.page_number,
  payload: r.payload,
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  runAt: r.run_at,
  lockedAt: r.locked_at,
  lockedBy: r.locked_by,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const createJob = async ({
  jobType,
  docId,
  payload = null,
  maxAttempts,
}: {
  jobType: string;
  docId: string;
  payload?: unknown;
  maxAttempts?: number;
}): Promise<IngestionJob> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query(
    `insert into ingestion_job (org_id, job_type, doc_id, payload, max_attempts)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [orgId, jobType, docId, payload ? JSON.stringify(payload) : null, maxAttempts ?? parseInt(process.env.MAX_JOB_ATTEMPTS || "3", 10)]
  );
  return mapRow(rows[0]);
};

export const claimNextJob = async (workerId: string): Promise<IngestionJob | null> => {
  const { rows } = await pool.query(
    `update ingestion_job
        set status = 'running', locked_at = now(), locked_by = $1,
            attempts = attempts + 1, updated_at = now()
      where id = (
        select id from ingestion_job
         where status = 'pending' and run_at <= now()
         order by run_at
         for update skip locked
         limit 1
      )
      returning *`,
    [workerId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
};

// Guarded on 'running' so a job cancelled while it ran stays cancelled.
export const completeJob = async (jobId: string): Promise<void> => {
  await pool.query(
    `update ingestion_job set status = 'completed', last_error = null, updated_at = now() where id = $1 and status = 'running'`,
    [jobId]
  );
};

/** Thrown inside a running job when an operator cancelled it; the worker discards the document instead of retrying. */
export class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = "JobCancelledError";
  }
}

export const isJobCancelled = async (jobId: string): Promise<boolean> => {
  const { rows } = await pool.query(`select status from ingestion_job where id = $1`, [jobId]);
  return rows[0]?.status === "cancelled";
};

export interface CancelledJob {
  docId: string | null;
  /** True when a worker had already claimed it: that worker stops at its next checkpoint and discards the document. */
  wasRunning: boolean;
}

/**
 * Cancels every pending or running job that was queued by `source` (e.g.
 * "drive-sync"). One statement, so it cannot race a worker's claim: a job is
 * either cancelled before it is claimed (never runs) or seen as running.
 */
export const cancelJobsBySource = async (source: string): Promise<CancelledJob[]> => {
  const { rows } = await pool.query(
    `with target as (
       select id, doc_id, status as prev
         from ingestion_job
        where status in ('pending','running') and payload->>'source' = $1
          for update
     )
     update ingestion_job j
        set status = 'cancelled', last_error = 'Cancelled by operator', updated_at = now()
       from target t
      where j.id = t.id
      returning t.doc_id, t.prev`,
    [source]
  );
  return rows.map((r: any) => ({ docId: r.doc_id, wasRunning: r.prev === "running" }));
};

export const countActiveJobsBySource = async (source: string): Promise<number> => {
  const { rows } = await pool.query(
    `select count(*)::int as n from ingestion_job where status in ('pending','running') and payload->>'source' = $1`,
    [source]
  );
  return rows[0].n;
};

export const failJob = async (
  job: IngestionJob,
  error: unknown,
  { retryable = true }: { retryable?: boolean } = {}
): Promise<void> => {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const exhausted = job.attempts >= job.maxAttempts;

  if (!retryable || exhausted) {
    await pool.query(
      `update ingestion_job set status = 'failed', last_error = $2, updated_at = now() where id = $1 and status <> 'cancelled'`,
      [job.id, message]
    );
    return;
  }

  const backoffMs = Math.min(30_000 * 2 ** (job.attempts - 1), 15 * 60_000);
  const jitterMs = Math.round(Math.random() * 0.3 * backoffMs);
  const runAt = new Date(Date.now() + backoffMs + jitterMs);

  await pool.query(
    `update ingestion_job
        set status = 'pending', last_error = $2, run_at = $3, locked_at = null, locked_by = null, updated_at = now()
      where id = $1 and status <> 'cancelled'`,
    [job.id, message, runAt]
  );
};

export const recoverStaleJobs = async (staleTimeoutMs: number): Promise<number> => {
  const cutoff = new Date(Date.now() - staleTimeoutMs);

  const { rows: stale } = await pool.query<{ id: string; attempts: number; max_attempts: number }>(
    `select id, attempts, max_attempts from ingestion_job where status = 'running' and locked_at < $1`,
    [cutoff]
  );

  for (const job of stale) {
    if (job.attempts >= job.max_attempts) {
      await pool.query(
        `update ingestion_job set status = 'failed', last_error = 'Stale: worker died without completing this job', updated_at = now() where id = $1`,
        [job.id]
      );
    } else {
      await pool.query(
        `update ingestion_job set status = 'pending', locked_at = null, locked_by = null, run_at = now(), updated_at = now() where id = $1`,
        [job.id]
      );
    }
  }

  return stale.length;
};

export const findLatestJobForDoc = async (docId: string): Promise<IngestionJob | null> => {
  const { rows } = await pool.query(`select * from ingestion_job where doc_id = $1 order by created_at desc limit 1`, [docId]);
  return rows[0] ? mapRow(rows[0]) : null;
};

export const getQueueStats = async (): Promise<Record<string, number>> => {
  const { rows } = await pool.query<{ status: string; count: string }>(
    `select status, count(*)::text as count from ingestion_job group by status`
  );
  const stats: Record<string, number> = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const row of rows) stats[row.status] = parseInt(row.count, 10);
  return stats;
};
