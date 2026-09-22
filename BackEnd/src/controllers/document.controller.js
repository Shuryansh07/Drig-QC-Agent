import { enqueueIngestion, enqueueRetry } from "../services/ragIngestion.service.js";
import * as documents from "../db/documents.js";
import * as documentPages from "../db/documentPages.js";
import { findLatestJobForDoc } from "../db/jobs.js";
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
        message: "A PDF or Word (.docx) file is required (multipart field name: file)",
      });
    }

    logger.info(`[upload] received "${req.file.originalname}" (${req.file.size} bytes)`);

    const result = await enqueueIngestion({
      filePath: req.file.path,
      fileName: req.file.originalname,
    });

    logger.info(`[upload] acknowledged in ${Date.now() - requestStart}ms`);

    if (result.duplicate) {
      return res.status(200).json({
        document_id: result.documentId,
        status: result.status,
        duplicate: true,
        message: "Identical file already ingested — reusing existing document",
      });
    }

    return res.status(202).json({
      document_id: result.documentId,
      job_id: result.jobId,
      status: result.status,
      message: "Document accepted for background processing",
    });
  } catch (error) {
    // A rejected file (wrong type, contents don't match) is the client's mistake:
    // say why, with the status the admin panel shows as-is.
    if (error.status && error.status < 500) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
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
 * The worker's job runner skips whatever already succeeded (completed
 * pages, an existing WorkDrive external_ref).
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
 * GET /api/documents — everything uploaded, newest first, with per-document
 * progress and how many sections/chunks it was split into. Backs the admin
 * panel, which polls this one endpoint instead of one status call per row.
 */
export const listDocumentsController = async (req, res) => {
  try {
    const rows = await documents.listDocuments();

    return res.status(200).json({
      documents: rows.map((d) => {
        const total = d.pageCount ?? 0;
        const processed = d.processedPages ?? 0;
        return {
          document_id: d.docId,
          title: d.title,
          status: d.ingestStatus,
          total_pages: d.pageCount,
          processed_pages: d.processedPages,
          failed_pages: d.failedPages,
          progress_percent: total > 0 ? Math.round((processed / total) * 100) : 0,
          parent_chunks: d.parentChunks,
          child_chunks: d.childChunks,
          live_version: d.liveVersion,
          archived: Boolean(d.externalRef && !d.externalRef.startsWith("upload:")),
          error_message: d.errorMessage,
          created_at: d.createdAt,
          updated_at: d.updatedAt,
        };
      }),
    });
  } catch (error) {
    logger.error("Document list error", error);
    return res.status(500).json({ success: false, message: "Failed to list documents" });
  }
};

/**
 * GET /api/documents/:id/status — lets a client poll progress instead of
 * holding a connection open. Pulls document + page-count breakdown.
 */
export const getDocumentStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const document = await documents.findById(id);
    if (!document) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    const pages = await documentPages.findPagesByDoc(id);
    const pageStatusCounts = pages.reduce((acc, p) => {
      acc[p.status] = (acc[p.status] || 0) + 1;
      return acc;
    }, {});

    const totalPages = document.pageCount ?? 0;
    const processedPages = document.processedPages ?? 0;
    const progressPercent = totalPages > 0 ? Math.round((processedPages / totalPages) * 100) : 0;
    const latestJob = await findLatestJobForDoc(id);

    return res.status(200).json({
      document_id: document.docId,
      status: document.ingestStatus,
      total_pages: document.pageCount,
      processed_pages: document.processedPages,
      failed_pages: document.failedPages,
      progress_percent: progressPercent,
      workdrive_file_id: document.externalRef?.startsWith("upload:") ? null : document.externalRef,
      error_message: document.errorMessage,
      page_status_breakdown: pageStatusCounts,
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
