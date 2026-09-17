import fs from "node:fs/promises";
import crypto from "node:crypto";
import { prisma } from "../config/prisma.js";
import { parsePdfPages } from "./pdf.service.js";
import { generateEmbeddings, toVectorLiteral } from "./embedding.service.js";
import { uploadOriginalPdf } from "./workdrive.service.js";
import { createJob } from "./jobQueue.service.js";
import { withTiming } from "../utils/timing.js";
import { logger } from "../utils/logger.js";

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
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks.filter(Boolean);
};

const mergeSplits = (splits, separator) => {
  const chunks = [];
  let current = "";

  for (const piece of splits) {
    const candidate = current ? current + separator + piece : piece;
    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // Carry the tail of the previous chunk forward so adjacent chunks
      // still overlap, same as the old hard-slice approach.
      const tail = current.slice(-CHUNK_OVERLAP);
      const candidateWithTail = tail ? tail + separator + piece : piece;
      current = candidateWithTail.length <= MAX_CHUNK_CHARS ? candidateWithTail : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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
 * Processes ONE page against its persisted document_pages state, skipping
 * whatever's already done:
 *  - Embedding already completed -> page is done, nothing to do.
 *  - Otherwise runs whichever steps are still needed and persists progress
 *    after EACH step succeeds, so a later failure doesn't lose earlier work.
 *
 * Vision LLM processing was deliberately removed — every page uses its raw
 * extracted text directly, whether or not it has a visual. `hasVisual` is
 * still recorded as informational metadata only.
 */
const processPage = async ({ document, page, pageRow, customerId, fileName, log }) => {
  await prisma.documentPage.update({
    where: { id: pageRow.id },
    data: { status: "processing", startedAt: pageRow.startedAt ?? new Date() },
  });

  try {
    const finalContent = page.text;
    await prisma.documentPage.update({ where: { id: pageRow.id }, data: { hasVisual: page.hasVisualContent } });
    log(`page ${page.pageNumber}: using extracted text directly (Vision disabled)`);

    if (!finalContent || !finalContent.trim()) {
      await prisma.documentPage.update({
        where: { id: pageRow.id },
        data: { status: "completed", embeddingCompleted: true, completedAt: new Date() },
      });
      log(`page ${page.pageNumber} has no extractable content -> skipped`);
      return { chunksCreated: 0 };
    }

    if (pageRow.embeddingCompleted) {
      log(`page ${page.pageNumber} already embedded -> skipped on retry`);
      return { chunksCreated: await prisma.documentChunk.count({ where: { documentId: document.id, pageNumber: page.pageNumber } }) };
    }

    await prisma.documentPage.update({ where: { id: pageRow.id }, data: { status: "embedding" } });

    const contentChunks = chunkContent(finalContent);
    const embeddings = await generateEmbeddings(contentChunks);

    await Promise.all(
      contentChunks.map((chunkText, i) =>
        prisma.$executeRaw`
          INSERT INTO document_chunks
            (document_id, customer_id, page_number, chunk_index, content, metadata, embedding)
          VALUES
            (${document.id}::uuid, ${customerId}, ${page.pageNumber}, ${i}, ${chunkText},
             ${JSON.stringify({ sourceFile: fileName, hadVisual: page.hasVisualContent })}::jsonb,
             ${toVectorLiteral(embeddings[i])}::vector)
          ON CONFLICT (document_id, page_number, chunk_index)
          DO UPDATE SET content = EXCLUDED.content, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding
        `
      )
    );
    log(`page ${page.pageNumber}: ${contentChunks.length} chunk(s) embedded + stored`);

    await prisma.documentPage.update({
      where: { id: pageRow.id },
      data: { status: "completed", embeddingCompleted: true, completedAt: new Date() },
    });

    return { chunksCreated: contentChunks.length };
  } catch (err) {
    // Previously silent — a page failure only showed up if you queried
    // document_pages directly. Now visible in the live log stream too,
    // with the page number and full provider error attached.
    logger.error(`[ingest ${document.id}] page ${page.pageNumber} failed`, err);

    await prisma.documentPage.update({
      where: { id: pageRow.id },
      data: {
        status: "failed",
        retryCount: { increment: 1 },
        lastError: (err.message || "Unknown page error").slice(0, 500),
      },
    });
    throw err;
  }
};

/**
 * The actual work — called ONLY by the worker (src/worker.js), never
 * synchronously from an HTTP handler. Runs RAG processing (pages not yet
 * completed) + WorkDrive archival (only if not already done) for a
 * document, and finalizes its status. Shared by both a fresh upload's job
 * and a retry's job — the only difference is whether document_pages rows
 * already exist and are (partially) completed; the upsert + skip-completed
 * logic below handles both uniformly.
 */
export const processDocument = async (document) => {
  const log = (msg) => logger.info(`[ingest ${document.id}] ${msg}`);
  const documentStart = Date.now();

  if (!document.tempFilePath) {
    throw new Error(`Document ${document.id} has no tempFilePath — cannot process without the original bytes`);
  }

  const buffer = await fs.readFile(document.tempFilePath);
  const fileName = document.fileName;

  await prisma.document.update({ where: { id: document.id }, data: { status: "rag_processing" } });

  const { totalPages, pages } = await withTiming(`[ingest ${document.id}] parsePdfPages (total)`, () =>
    parsePdfPages(buffer)
  );
  log(`pages detected: ${totalPages}`);

  // TEMP DEBUG — shows exactly what parsePdfPages() returned for this
  // upload. Remove once you've seen what you need.
  console.log(`\n=== parsePdfPages() raw return — document ${document.id} ===`);
  console.log("totalPages:", totalPages);
  console.table(
    pages.map((p) => ({
      pageNumber: p.pageNumber,
      textLength: p.text.length,
      textPreview: p.text.slice(0, 70).replace(/\s+/g, " ") + (p.text.length > 70 ? "…" : ""),
      hasVisualContent: p.hasVisualContent,
    }))
  );
  console.log(`=== end parsePdfPages() output ===\n`);

  // Upsert is what makes this safe to call again on retry: existing rows
  // (and their progress) are left untouched, only missing ones are created.
  await Promise.all(
    pages.map((page) =>
      prisma.documentPage.upsert({
        where: { documentId_pageNumber: { documentId: document.id, pageNumber: page.pageNumber } },
        create: { documentId: document.id, pageNumber: page.pageNumber, status: "pending" },
        update: {},
      })
    )
  );

  const existingPageRows = await prisma.documentPage.findMany({ where: { documentId: document.id } });
  const pageRowByNumber = new Map(existingPageRows.map((r) => [r.pageNumber, r]));
  const pagesToProcess = pages.filter((p) => pageRowByNumber.get(p.pageNumber)?.status !== "completed");

  log(`${pages.length - pagesToProcess.length}/${pages.length} page(s) already completed -> skipping; processing ${pagesToProcess.length}`);

  for (let i = 0; i < pagesToProcess.length; i += PAGE_CONCURRENCY) {
    const batch = pagesToProcess.slice(i, i + PAGE_CONCURRENCY);
    await Promise.allSettled(
      batch.map((page) =>
        withTiming(`[ingest ${document.id}] page ${page.pageNumber} TOTAL`, () =>
          processPage({
            document,
            page,
            pageRow: pageRowByNumber.get(page.pageNumber),
            customerId: document.customerId,
            fileName,
            log,
          })
        )
      )
    );
  }

  const finalPageRows = await prisma.documentPage.findMany({ where: { documentId: document.id } });
  const completedPages = finalPageRows.filter((r) => r.status === "completed");
  const failedPages = finalPageRows.filter((r) => r.status === "failed");
  const chunksCreated = await prisma.documentChunk.count({ where: { documentId: document.id } });

  // WorkDrive only after RAG processing, and only if not already archived —
  // a retry with workdriveFileId already set skips straight past this.
  let workdriveFileId = document.workdriveFileId;
  if (!workdriveFileId && completedPages.length > 0) {
    await prisma.document.update({ where: { id: document.id }, data: { status: "workdrive_uploading" } });
    try {
      const result = await uploadOriginalPdf(buffer, fileName, document.id);
      workdriveFileId = result.workdriveFileId;
      log(`WorkDrive upload complete -> ${workdriveFileId}`);
    } catch (err) {
      logger.error(`[ingest ${document.id}] WorkDrive upload failed (non-fatal, retryable)`, err);
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
  // `completed_with_errors` (some pages still failed) and `rag_completed`
  // (WorkDrive still pending) both keep the file — either could still need
  // it on a future retry.
  const canDeleteTempFile = status === "completed" || status === "failed";

  await prisma.document.update({
    where: { id: document.id },
    data: {
      status,
      pageCount: totalPages,
      processedPages: completedPages.length,
      failedPages: failedPages.length,
      workdriveFileId,
      workdriveFolderId: workdriveFileId ? process.env.WORKDRIVE_FOLDER_ID : null,
      tempFilePath: canDeleteTempFile ? null : document.tempFilePath,
      errorMessage:
        failedPages.length > 0
          ? `Failed page(s): ${failedPages.map((p) => p.pageNumber).join(", ")}`
          : !workdriveFileId
            ? "WorkDrive upload pending/failed — retry to complete archival"
            : null,
    },
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
  return { documentId: document.id, status, pagesProcessed: completedPages.length, totalPages, chunksCreated, failedPages: failedPages.map((p) => p.pageNumber), workdriveFileId };
};

/**
 * HTTP-fast path: saves the temp file's hash, dedups, creates the document
 * row (status=queued), and enqueues a `process_document` job. Does NOT parse
 * the PDF, call Vision, embed, or touch WorkDrive — all of that happens
 * later in the worker. This is what lets POST /api/documents/upload return
 * 202 immediately regardless of document size.
 */
export const enqueueIngestion = async ({ filePath, fileName, customerId }) => {
  const resolvedCustomerId = customerId || "default";
  const buffer = await fs.readFile(filePath);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  // Dedup: identical bytes already fully ingested for this customer -> skip
  // creating a new document/job entirely, no processing needed.
  const existing = await prisma.document.findFirst({
    where: { customerId: resolvedCustomerId, sha256, status: { in: ["completed", "completed_with_errors"] } },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    logger.info(`[upload] duplicate (sha256 match) for customer ${resolvedCustomerId} -> reusing document ${existing.id}`);
    await deleteTempFile(filePath);
    return {
      documentId: existing.id,
      status: existing.status,
      duplicate: true,
    };
  }

  const document = await prisma.document.create({
    data: {
      fileName,
      customerId: resolvedCustomerId,
      sha256,
      status: "queued",
      tempFilePath: filePath,
    },
  });

  const job = await createJob({ jobType: "process_document", documentId: document.id });

  logger.info(`[upload] document ${document.id} queued (job ${job.id})`);

  return { documentId: document.id, jobId: job.id, status: document.status };
};

/**
 * HTTP-fast path for retry: validates the document is in a retryable state
 * and the temp file is still present, then enqueues another
 * `process_document` job. Does NOT do any processing itself — the worker
 * picks it up and processDocument() skips whatever's already done.
 */
export const enqueueRetry = async (documentId) => {
  const document = await prisma.document.findUnique({ where: { id: documentId } });

  if (!document) {
    const err = new Error("Document not found");
    err.status = 404;
    throw err;
  }

  if (document.status === "completed") {
    return { documentId, status: document.status, message: "Already completed — nothing to retry" };
  }
  if (["queued", "processing", "rag_processing", "workdrive_uploading"].includes(document.status)) {
    const err = new Error(`Document is currently ${document.status} — cannot retry concurrently`);
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

  await prisma.document.update({ where: { id: document.id }, data: { status: "queued" } });
  const job = await createJob({ jobType: "process_document", documentId: document.id });

  logger.info(`[retry] document ${document.id} re-queued (job ${job.id})`);

  return { documentId: document.id, jobId: job.id, status: "queued" };
};
