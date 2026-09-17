import { prisma } from "../config/prisma.js";
import { logger } from "../utils/logger.js";

const STALE_JOB_TIMEOUT_MS = parseInt(process.env.STALE_JOB_TIMEOUT_MS || "900000", 10); // 15 min

/**
 * Creates a job row. Fast, synchronous-feeling — this is what lets the
 * upload/retry HTTP handlers return 202 immediately instead of blocking on
 * ingestion.
 */
export const createJob = async ({ jobType, documentId, payload = null, maxAttempts }) => {
  const job = await prisma.job.create({
    data: {
      jobType,
      documentId,
      payload,
      maxAttempts: maxAttempts ?? parseInt(process.env.MAX_JOB_ATTEMPTS || "3", 10),
    },
  });

  logger.info(`[job ${job.id}] created (type: ${jobType}, document: ${documentId})`);
  return job;
};

/**
 * Atomically claims the oldest eligible pending job for this worker.
 * `FOR UPDATE SKIP LOCKED` inside the subquery is what makes this safe under
 * concurrent workers: two workers racing this same query will never claim
 * the same row — one gets it, the other's SKIP LOCKED passes over it and
 * finds the next one (or nothing).
 */
export const claimNextJob = async (workerId) => {
  const rows = await prisma.$queryRaw`
    UPDATE jobs
    SET status = 'running',
        locked_at = now(),
        locked_by = ${workerId},
        attempts = attempts + 1,
        updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_at <= now()
      ORDER BY run_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, job_type AS "jobType", document_id AS "documentId", page_number AS "pageNumber",
              payload, status, attempts, max_attempts AS "maxAttempts", run_at AS "runAt",
              locked_at AS "lockedAt", locked_by AS "lockedBy", last_error AS "lastError",
              created_at AS "createdAt", updated_at AS "updatedAt"
  `;

  return rows[0] ?? null;
};

export const completeJob = async (jobId) => {
  await prisma.job.update({ where: { id: jobId }, data: { status: "completed", lastError: null } });
};

/**
 * Retryable failures get rescheduled with exponential backoff + jitter, up
 * to max_attempts. Beyond that (or for a caller-marked permanent failure),
 * the job is marked failed and stops being claimed.
 */
export const failJob = async (job, error, { retryable = true } = {}) => {
  const message = (error?.message || String(error)).slice(0, 1000);
  const exhausted = job.attempts >= job.maxAttempts;

  if (!retryable || exhausted) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "failed", lastError: message },
    });
    logger.error(
      `[job ${job.id}] failed permanently (attempt ${job.attempts}/${job.maxAttempts}, retryable: ${retryable})`,
      error
    );
    return;
  }

  const backoffMs = Math.min(30_000 * 2 ** (job.attempts - 1), 15 * 60_000);
  const jitterMs = Math.round(Math.random() * 0.3 * backoffMs);
  const runAt = new Date(Date.now() + backoffMs + jitterMs);

  await prisma.job.update({
    where: { id: job.id },
    data: { status: "pending", lastError: message, runAt, lockedAt: null, lockedBy: null },
  });

  logger.warn(
    `[job ${job.id}] failed (attempt ${job.attempts}/${job.maxAttempts}), retrying at ${runAt.toISOString()}: ${message}`
  );
};

/**
 * Any job still `running` after STALE_JOB_TIMEOUT_MS was claimed by a worker
 * that crashed/restarted without finishing it — nothing will ever mark it
 * complete or failed on its own. Requeue it (as a retry, respecting
 * max_attempts) so it doesn't sit stuck forever.
 */
export const recoverStaleJobs = async () => {
  const cutoff = new Date(Date.now() - STALE_JOB_TIMEOUT_MS);

  const stale = await prisma.job.findMany({
    where: { status: "running", lockedAt: { lt: cutoff } },
  });

  for (const job of stale) {
    if (job.attempts >= job.maxAttempts) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "failed", lastError: "Stale: worker died without completing this job" },
      });
      logger.error(`[job ${job.id}] stale and out of attempts -> marked failed`);
    } else {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "pending", lockedAt: null, lockedBy: null, runAt: new Date() },
      });
      logger.warn(`[job ${job.id}] stale (locked since ${job.lockedAt.toISOString()}) -> requeued`);
    }
  }

  if (stale.length > 0) logger.info(`[jobs] recovered ${stale.length} stale job(s)`);
  return stale.length;
};

/** For the health/status views — cheap aggregate counts, no row bodies. */
export const getQueueStats = async () => {
  const rows = await prisma.job.groupBy({ by: ["status"], _count: true });
  const stats = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) stats[row.status] = row._count;

  const staleCutoff = new Date(Date.now() - STALE_JOB_TIMEOUT_MS);
  stats.stale = await prisma.job.count({ where: { status: "running", lockedAt: { lt: staleCutoff } } });

  return stats;
};
