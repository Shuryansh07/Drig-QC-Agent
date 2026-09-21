import fs from "node:fs/promises";
import crypto from "node:crypto";
import { parsePdfPages } from "./pdf.service.js";
import { generateEmbeddings } from "./embedding.service.js";
import { uploadOriginalPdf } from "./workdrive.service.js";
import { withTiming } from "../utils/timing.js";
import { logger } from "../utils/logger.js";
import * as documents from "../db/documents.js";
import * as documentPages from "../db/documentPages.js";
import * as chunks from "../db/chunks.js";
import * as jobs from "../db/jobs.js";
import { publishDocumentVersion } from "../db/ingestion.js";

const MAX_CHUNK_CHARS = 1400;
const CHUNK_OVERLAP = 150;
// Pages are embedding calls — network-bound. Processing them in
// bounded-concurrency batches instead of one at a time cuts wall-clock time.
// This bounds how many pages of ONE document are started at once; the
// separate global embedding limiter (concurrencyLimiter.js) bounds the
// actual API call concurrency across ALL documents a worker is running.
const PAGE_CONCURRENCY = parseInt(process.env.PAGE_CONCURRENCY || "3", 10);

// A page's extracted text is usually one chunk. Only split when it's long
// enough to benefit from smaller, more targeted chunks.
//
// Recursive splitting: tries paragraph breaks first, then line breaks, then
// sentence breaks, then word breaks — only falling back to a hard character
// cut if none of those get a piece under the limit (in practice, never).
// This keeps chunk boundaries at natural text boundaries instead of landing
// mid-sentence, while still applying the same overlap as before for
// continuity between adjacent chunks.
const CHUNK_SEPARATORS = ["\n\n", "\n", ". ", " "];

const hardSlice = (text) => {
  const result = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    result.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return result.filter(Boolean);
};

const mergeSplits = (splits, separator) => {
  const result = [];
  let current = "";

  for (const piece of splits) {
    const candidate = current ? current + separator + piece : piece;
    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate;
    } else {
      if (current) result.push(current);
      // Carry the tail of the previous chunk forward so adjacent chunks
      // still overlap, same as the old hard-slice approach.
      const tail = current.slice(-CHUNK_OVERLAP);
      const candidateWithTail = tail ? tail + separator + piece : piece;
      current = candidateWithTail.length <= MAX_CHUNK_CHARS ? candidateWithTail : piece;
    }
  }
  if (current) result.push(current);
  return result;
};

const recursiveSplit = (text, separators) => {
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  const [separator, ...remaining] = separators;
  if (separator === undefined) return hardSlice(text);

  const splits = text.split(separator).filter((s) => s.length > 0);
  const merged = mergeSplits(splits, separator);

  const result = [];
  for (const piece of merged) {
    if (piece.length > MAX_CHUNK_CHARS) {
      result.push(...recursiveSplit(piece, remaining));
    } else {
      result.push(piece);
    }
  }
  return result;
};

const chunkContent = (content) => recursiveSplit(content, CHUNK_SEPARATORS).filter(Boolean);

const deleteTempFile = async (filePath, log) => {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
    log?.(`temp file deleted: ${filePath}`);
  } catch (err) {
    if (err.code !== "ENOENT") logger.error(`Failed to delete temp file ${filePath}`, err);
  }
};

/**
 * Processes ONE page against its persisted kb_document_page state, skipping
 * whatever's already done:
 *  - Embedding already completed -> page is done, nothing to do.
 *  - Otherwise runs whichever steps are still needed and persists progress
 *    after EACH step succeeds, so a later failure doesn't lose earlier work.
 */
const processPage = async ({ docId, page, pageRow, fileName, log }) => {
  await documentPages.updatePage(pageRow.id, { status: "processing", startedAt: pageRow.startedAt ?? new Date() });

  try {
    const finalContent = page.text;
    await documentPages.updatePage(pageRow.id, { hasVisual: page.hasVisualContent });
    log(`page ${page.pageNumber}: using extracted text directly (Vision disabled)`);

    if (!finalContent || !finalContent.trim()) {
      await documentPages.updatePage(pageRow.id, { status: "completed", embeddingCompleted: true, completedAt: new Date() });
      log(`page ${page.pageNumber} has no extractable content -> skipped`);
      return { chunksCreated: 0 };
    }

    if (pageRow.embeddingCompleted) {
      log(`page ${page.pageNumber} already embedded -> skipped on retry`);
      return { chunksCreated: await chunks.countChunksForPage(docId, page.pageNumber) };
    }

    await documentPages.updatePage(pageRow.id, { status: "embedding" });

    const contentChunks = chunkContent(finalContent);
    const embeddings = await generateEmbeddings(contentChunks);

    await chunks.upsertChunks(
      docId,
      contentChunks.map((chunkText, i) => ({
        pageNumber: page.pageNumber,
        chunkIndex: i,
        content: chunkText,
        embedding: embeddings[i],
        metadata: { sourceFile: fileName, hadVisual: page.hasVisualContent },
      }))
    );
    log(`page ${page.pageNumber}: ${contentChunks.length} chunk(s) embedded + stored`);

    await documentPages.updatePage(pageRow.id, { status: "completed", embeddingCompleted: true, completedAt: new Date() });

    return { chunksCreated: contentChunks.length };
  } catch (err) {
    // Previously silent — a page failure only showed up if you queried
    // kb_document_page directly. Now visible in the live log stream too,
    // with the page number and full provider error attached.
    logger.error(`[ingest ${docId}] page ${page.pageNumber} failed`, err);
    await documentPages.incrementRetryCount(pageRow.id, (err.message || "Unknown page error").slice(0, 500));
    throw err;
  }
};

/**
 * The actual work — called ONLY by the worker (src/worker.js), never
 * synchronously from an HTTP handler. Runs RAG processing (pages not yet
 * completed) + WorkDrive archival (only if not already done) for a
 * document, publishes it once chunks exist, and finalizes its status.
 * Shared by both a fresh upload's job and a retry's job.
 */
export const processDocument = async (document) => {
  const log = (msg) => logger.info(`[ingest ${document.docId}] ${msg}`);
  const documentStart = Date.now();

  if (!document.tempFilePath) {
    throw new Error(`Document ${document.docId} has no tempFilePath — cannot process without the original bytes`);
  }

  const buffer = await fs.readFile(document.tempFilePath);
  const fileName = document.title;

  await documents.updateIngestState(document.docId, { ingestStatus: "rag_processing" });

  const { totalPages, pages } = await withTiming(`[ingest ${document.docId}] parsePdfPages (total)`, () =>
    parsePdfPages(buffer)
  );
  log(`pages detected: ${totalPages}`);

  // Upsert is what makes this safe to call again on retry: existing rows
  // (and their progress) are left untouched, only missing ones are created.
  await documentPages.ensurePages(document.docId, pages.map((p) => p.pageNumber));

  const existingPageRows = await documentPages.findPagesByDoc(document.docId);
  const pageRowByNumber = new Map(existingPageRows.map((r) => [r.pageNumber, r]));
  const pagesToProcess = pages.filter((p) => pageRowByNumber.get(p.pageNumber)?.status !== "completed");

  log(`${pages.length - pagesToProcess.length}/${pages.length} page(s) already completed -> skipping; processing ${pagesToProcess.length}`);

  for (let i = 0; i < pagesToProcess.length; i += PAGE_CONCURRENCY) {
    const batch = pagesToProcess.slice(i, i + PAGE_CONCURRENCY);
    await Promise.allSettled(
      batch.map((page) =>
        withTiming(`[ingest ${document.docId}] page ${page.pageNumber} TOTAL`, () =>
          processPage({
            docId: document.docId,
            page,
            pageRow: pageRowByNumber.get(page.pageNumber),
            fileName,
            log,
          })
        )
      )
    );
  }

  const finalPageRows = await documentPages.findPagesByDoc(document.docId);
  const completedPages = finalPageRows.filter((r) => r.status === "completed");
  const failedPages = finalPageRows.filter((r) => r.status === "failed");
  const chunksCreated = await chunks.countChunks(document.docId);

  // Only published (is_live) chunks are searchable (DATABASE.md §4/§6.1) —
  // publish as soon as there's anything to publish, even on a partial
  // (completed_with_errors) run, so the pages that DID succeed are usable.
  if (chunksCreated > 0) {
    await publishDocumentVersion(document.docId, 1);
    log(`published version 1 (${chunksCreated} chunks live)`);
  }

  // WorkDrive only after RAG processing, and only if not already archived —
  // a retry with an external_ref already set skips straight past this.
  let workdriveFileId = document.externalRef?.startsWith("upload:") ? null : document.externalRef;
  if (!workdriveFileId && completedPages.length > 0) {
    await documents.updateIngestState(document.docId, { ingestStatus: "workdrive_uploading" });
    try {
      const result = await uploadOriginalPdf(buffer, fileName, document.docId);
      workdriveFileId = result.workdriveFileId;
      await documents.updateIngestState(document.docId, {
        externalRef: workdriveFileId,
        workdriveFolderId: result.workdriveFolderId,
      });
      log(`WorkDrive upload complete -> ${workdriveFileId}`);
    } catch (err) {
      logger.error(`[ingest ${document.docId}] WorkDrive upload failed (non-fatal, retryable)`, err);
    }
  } else if (workdriveFileId) {
    log(`WorkDrive already archived (${workdriveFileId}) -> skipped`);
  }

  let status;
  if (completedPages.length === 0) {
    status = "failed";
  } else if (failedPages.length > 0) {
    status = "completed_with_errors";
  } else if (workdriveFileId) {
    status = "completed";
  } else {
    status = "rag_completed";
  }

  // Temp file is only safe to delete once there is NO remaining retryable
  // work that could need the original bytes: fully completed (no failed
  // pages, WorkDrive succeeded), or a fatal failure with nothing to retry.
  const canDeleteTempFile = status === "completed" || status === "failed";

  await documents.updateIngestState(document.docId, {
    ingestStatus: status,
    pageCount: totalPages,
    processedPages: completedPages.length,
    failedPages: failedPages.length,
    tempFilePath: canDeleteTempFile ? null : document.tempFilePath,
    errorMessage:
      failedPages.length > 0
        ? `Failed page(s): ${failedPages.map((p) => p.pageNumber).join(", ")}`
        : !workdriveFileId
          ? "WorkDrive upload pending/failed — retry to complete archival"
          : null,
  });

  if (canDeleteTempFile) {
    await deleteTempFile(document.tempFilePath, log);
  } else {
    const reason = failedPages.length > 0 ? `${failedPages.length} page(s) still failed` : "WorkDrive not yet archived";
    log(`temp file kept for retry (${reason}): ${document.tempFilePath}`);
  }

  log(
    `document ${status} — pages: ${totalPages} (${completedPages.length} ok, ${failedPages.length} failed), ` +
      `chunks: ${chunksCreated}, workdrive: ${workdriveFileId ?? "pending"}, total time: ${Date.now() - documentStart}ms`
  );

  // A partial failure (some pages down, or WorkDrive still pending) is not a
  // thrown error — it's a valid, recorded outcome the retry endpoint can act
  // on. Only genuinely unexpected exceptions (caught by the worker) mark the
  // job itself failed; this function returning normally always means "the
  // document's state was correctly persisted," regardless of which status.
  return { docId: document.docId, status, pagesProcessed: completedPages.length, totalPages, chunksCreated, failedPages: failedPages.map((p) => p.pageNumber), workdriveFileId };
};

/**
 * HTTP-fast path: saves the temp file's hash, dedups, creates the document
 * row (status=queued), and enqueues a `process_document` job. Does NOT parse
 * the PDF, call Vision, embed, or touch WorkDrive — all of that happens
 * later in the worker. This is what lets POST /api/documents/upload return
 * 202 immediately regardless of document size.
 */
export const enqueueIngestion = async ({ filePath, fileName }) => {
  const buffer = await fs.readFile(filePath);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  // Dedup: identical bytes already fully ingested -> skip creating a new
  // document/job entirely, no processing needed.
  const existing = await documents.findByContentHash(sha256);

  if (existing) {
    logger.info(`[upload] duplicate (sha256 match) -> reusing document ${existing.docId}`);
    await deleteTempFile(filePath);
    return { documentId: existing.docId, status: existing.ingestStatus, duplicate: true };
  }

  const document = await documents.createDocument({ title: fileName, contentHash: sha256, tempFilePath: filePath });
  const job = await jobs.createJob({ jobType: "process_document", docId: document.docId });

  logger.info(`[upload] document ${document.docId} queued (job ${job.id})`);

  return { documentId: document.docId, jobId: job.id, status: document.ingestStatus };
};

/**
 * HTTP-fast path for retry: validates the document is in a retryable state
 * and the temp file is still present, then enqueues another
 * `process_document` job. Does NOT do any processing itself — the worker
 * picks it up and processDocument() skips whatever's already done.
 */
export const enqueueRetry = async (docId) => {
  const document = await documents.findById(docId);

  if (!document) {
    const err = new Error("Document not found");
    err.status = 404;
    throw err;
  }

  if (document.ingestStatus === "completed") {
    return { documentId: docId, status: document.ingestStatus, message: "Already completed — nothing to retry" };
  }
  if (["queued", "processing", "rag_processing", "workdrive_uploading"].includes(document.ingestStatus)) {
    const err = new Error(`Document is currently ${document.ingestStatus} — cannot retry concurrently`);
    err.status = 409;
    throw err;
  }

  if (!document.tempFilePath) {
    const err = new Error(
      "Original PDF is no longer available for retry (already archived or cleared). Please re-upload the file."
    );
    err.status = 410;
    throw err;
  }

  try {
    await fs.access(document.tempFilePath);
  } catch {
    const err = new Error(
      `Temp file missing on disk (${document.tempFilePath}) — cannot retry without the original bytes. Please re-upload.`
    );
    err.status = 410;
    throw err;
  }

  await documents.updateIngestState(document.docId, { ingestStatus: "queued" });
  const job = await jobs.createJob({ jobType: "process_document", docId: document.docId });

  logger.info(`[retry] document ${document.docId} re-queued (job ${job.id})`);

  return { documentId: document.docId, jobId: job.id, status: "queued" };
};
