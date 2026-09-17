import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import { prisma } from "./config/prisma.js";
import { logger } from "./utils/logger.js";
import { claimNextJob, completeJob, failJob, recoverStaleJobs } from "./services/jobQueue.service.js";
import { processDocument } from "./services/ragIngestion.service.js";
import { TEMP_UPLOAD_DIR } from "./middleware/upload.middleware.js";

dotenv.config();

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const JOB_POLL_INTERVAL_MS = parseInt(process.env.JOB_POLL_INTERVAL_MS || "1000", 10);
const JOB_CONCURRENCY = parseInt(process.env.JOB_CONCURRENCY || "2", 10);
const STALE_JOB_TIMEOUT_MS = parseInt(process.env.STALE_JOB_TIMEOUT_MS || "900000", 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;
let activeJobs = 0;
const inFlight = new Set();

// 429/408/5xx/unknown network failures are retryable; anything with a clear
// 4xx client-error status (bad request, invalid PDF caught earlier, etc.)
// is not — retrying a permanent error just burns attempts for nothing.
const isRetryableError = (err) => {
  const status = err?.status ?? err?.response?.status;
  if (status !== undefined) return status === 408 || status === 429 || (status >= 500 && status < 600);
  return true;
};

const runJob = async (job) => {
  activeJobs++;
  const start = Date.now();
  logger.info(`[job ${job.id}] claimed by ${WORKER_ID} (type: ${job.jobType}, document: ${job.documentId}, attempt ${job.attempts}/${job.maxAttempts})`);

  try {
    if (job.jobType !== "process_document") {
      throw new Error(`Unknown job_type: ${job.jobType}`);
    }
    if (!job.documentId) {
      throw new Error(`Job ${job.id} has no documentId`);
    }

    const document = await prisma.document.findUnique({ where: { id: job.documentId } });
    if (!document) {
      throw new Error(`Document ${job.documentId} not found`);
    }

    logger.info(`[job ${job.id}] document processing started (file: ${document.fileName})`);
    const result = await processDocument(document);

    await completeJob(job.id);
    logger.info(
      `[job ${job.id}] completed in ${Date.now() - start}ms (document status: ${result.status}, ` +
        `${result.pagesProcessed}/${result.totalPages} pages, ${result.chunksCreated} chunks)`
    );
  } catch (err) {
    logger.error(`[job ${job.id}] failed after ${Date.now() - start}ms`, err);

    const retryable = isRetryableError(err);
    await failJob(job, err, { retryable });

    // If this was the job's last attempt, the document must not be left
    // showing a stale in-progress status forever — reflect the permanent
    // failure so it's visibly retryable via POST /:id/retry instead of
    // silently stuck.
    const permanentlyFailed = !retryable || job.attempts >= job.maxAttempts;
    if (permanentlyFailed && job.documentId) {
      await prisma.document.update({
        where: { id: job.documentId },
        data: {
          status: "failed",
          errorMessage: `Job failed permanently after ${job.attempts} attempt(s): ${(err.message || String(err)).slice(0, 400)}`,
        },
      });
      logger.warn(`[job ${job.id}] document ${job.documentId} marked failed (job exhausted retries)`);
    }
  } finally {
    activeJobs--;
  }
};

const pollLoop = async () => {
  while (!shuttingDown) {
    try {
      if (activeJobs < JOB_CONCURRENCY) {
        const job = await claimNextJob(WORKER_ID);
        if (job) {
          const promise = runJob(job).finally(() => inFlight.delete(promise));
          inFlight.add(promise);
          continue; // try to claim more immediately, up to JOB_CONCURRENCY
        }
      }
    } catch (err) {
      logger.error("[worker] poll loop error", err);
    }
    await sleep(JOB_POLL_INTERVAL_MS);
  }
};

/**
 * Deletes temp upload files nobody references: no document row points at
 * them (crashed before enqueueIngestion finished creating one), or the
 * owning document's tempFilePath was already cleared (fully done). Only
 * touches files older than 10 minutes so a file mid-upload right now is
 * never at risk.
 */
const cleanupOrphanedTempFiles = async () => {
  let entries;
  try {
    entries = await fs.readdir(TEMP_UPLOAD_DIR);
  } catch {
    return;
  }

  const referenced = new Set(
    (await prisma.document.findMany({ where: { tempFilePath: { not: null } }, select: { tempFilePath: true } })).map(
      (d) => d.tempFilePath
    )
  );

  const TEN_MINUTES = 10 * 60 * 1000;
  let removed = 0;

  for (const entry of entries) {
    const fullPath = path.join(TEMP_UPLOAD_DIR, entry);
    if (referenced.has(fullPath)) continue;

    try {
      const stat = await fs.stat(fullPath);
      if (Date.now() - stat.mtimeMs > TEN_MINUTES) {
        await fs.unlink(fullPath);
        removed++;
      }
    } catch {
      // Already gone or inaccessible — nothing to do.
    }
  }

  if (removed > 0) logger.info(`[worker] cleaned up ${removed} orphaned temp upload file(s)`);
};

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[worker] received ${signal} — waiting for ${inFlight.size} in-flight job(s) to finish before exiting`);

  await Promise.allSettled([...inFlight]);
  await prisma.$disconnect();

  logger.info("[worker] shutdown complete");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const start = async () => {
  logger.info(
    `[worker] starting (id: ${WORKER_ID}, job concurrency: ${JOB_CONCURRENCY}, poll interval: ${JOB_POLL_INTERVAL_MS}ms, ` +
      `stale timeout: ${STALE_JOB_TIMEOUT_MS}ms)`
  );

  await recoverStaleJobs();
  await cleanupOrphanedTempFiles();

  // Periodic sweep, not just at startup — a job can go stale at any point
  // during a long-running worker's life (e.g. the worker itself is killed
  // mid-job by an operator, not just at process start).
  setInterval(() => {
    recoverStaleJobs().catch((err) => logger.error("[worker] periodic stale-job recovery failed", err));
  }, Math.min(STALE_JOB_TIMEOUT_MS, 5 * 60_000));

  await pollLoop();
};

start().catch((err) => {
  logger.error("[worker] fatal startup error", err);
  process.exit(1);
});
