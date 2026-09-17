import { enqueueIngestion, enqueueRetry } from "../services/ragIngestion.service.js";
import { prisma } from "../config/prisma.js";
import { logger } from "../utils/logger.js";

/**
 * Fast path: saves the file, hashes it, creates the document + a
 * process_document job, and returns 202 immediately. Does not parse the PDF,
 * call Vision, embed, or touch WorkDrive — src/worker.js does all of that.
 */
export const uploadDocument = async (req, res) => {
  const requestStart = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "PDF file is required (multipart field name: file)",
      });
    }

    const customerId = req.body?.customer_id || "default";

    logger.info(
      `[upload] received "${req.file.originalname}" (${req.file.size} bytes, customer: ${customerId})`
    );

    const result = await enqueueIngestion({
      filePath: req.file.path,
      fileName: req.file.originalname,
      customerId,
    });

    logger.info(`[upload] acknowledged in ${Date.now() - requestStart}ms`);

    if (result.duplicate) {
      return res.status(200).json({
        document_id: result.documentId,
        status: result.status,
        duplicate: true,
        message: "Identical file already ingested for this customer — reusing existing document",
      });
    }

    return res.status(202).json({
      document_id: result.documentId,
      job_id: result.jobId,
      status: result.status,
      message: "Document accepted for background processing",
    });
  } catch (error) {
    logger.error("Document upload error", error);
    return res.status(500).json({
      success: false,
      message: "Failed to accept document",
      error: error.message,
    });
  }
};

/**
 * Fast path: enqueues another process_document job and returns immediately.
 * The worker's job runner skips whatever already succeeded (persisted
 * Vision output, completed pages, an existing workdrive_file_id).
 */
export const retryDocumentController = async (req, res) => {
  const requestStart = Date.now();
  try {
    const { id } = req.params;
    logger.info(`[retry] requested for document ${id}`);

    const result = await enqueueRetry(id);

    logger.info(`[retry] acknowledged in ${Date.now() - requestStart}ms`);

    // 202 only when a job was actually enqueued; the "already completed"
    // no-op case queued nothing, so 200 is the honest response there.
    return res.status(result.jobId ? 202 : 200).json({
      document_id: result.documentId,
      status: result.status,
      ...(result.jobId && { job_id: result.jobId }),
      ...(result.message && { message: result.message }),
    });
  } catch (error) {
    logger.error("Document retry error", error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to retry document",
    });
  }
};

/**
 * GET /api/documents/:id/status — lets a client poll progress instead of
 * holding a connection open. Pulls document + page-count breakdown + the
 * latest job's state.
 */
export const getDocumentStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const document = await prisma.document.findUnique({ where: { id } });
    if (!document) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    const pageStatusCounts = await prisma.documentPage.groupBy({
      by: ["status"],
      where: { documentId: id },
      _count: true,
    });

    const latestJob = await prisma.job.findFirst({
      where: { documentId: id },
      orderBy: { createdAt: "desc" },
    });

    const totalPages = document.pageCount ?? 0;
    const processedPages = document.processedPages ?? 0;
    const progressPercent = totalPages > 0 ? Math.round((processedPages / totalPages) * 100) : 0;

    return res.status(200).json({
      document_id: document.id,
      status: document.status,
      total_pages: document.pageCount,
      processed_pages: document.processedPages,
      failed_pages: document.failedPages,
      progress_percent: progressPercent,
      workdrive_file_id: document.workdriveFileId,
      error_message: document.errorMessage,
      page_status_breakdown: Object.fromEntries(pageStatusCounts.map((r) => [r.status, r._count])),
      job: latestJob
        ? {
            id: latestJob.id,
            status: latestJob.status,
            attempts: latestJob.attempts,
            max_attempts: latestJob.maxAttempts,
            last_error: latestJob.lastError,
          }
        : null,
      created_at: document.createdAt,
      updated_at: document.updatedAt,
    });
  } catch (error) {
    logger.error("Document status error", error);
    return res.status(500).json({ success: false, message: "Failed to fetch document status" });
  }
};
