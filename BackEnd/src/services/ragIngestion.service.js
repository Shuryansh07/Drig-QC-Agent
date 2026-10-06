import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { extractDocumentBlocks } from "./chunking/pdfStructure.js";
import { extractDocxBlocks } from "./chunking/docxStructure.js";
import { extractImageBlocks } from "./chunking/imageStructure.js";
import { kindOfFileName, describeKind, mimeOfKind, bufferMatchesKind, unsupportedTypeMessage, isImageKind } from "./chunking/documentTypes.js";
import * as storage from "./storage.service.js";
import { buildChunkTree } from "./chunking/chunker.js";
import { enrichWithVisuals } from "./chunking/visualEnrichment.js";
import * as figures from "../db/images.js";
import { loadChunkParams } from "./chunking/params.js";
import { generateEmbeddings, EMBEDDING_MODEL } from "./embedding.service.js";
import { uploadOriginalFile, deleteOriginalFile } from "./workdrive.service.js";
import { withTiming } from "../utils/timing.js";
import { logger } from "../utils/logger.js";
import * as documents from "../db/documents.js";
import * as documentPages from "../db/documentPages.js";
import * as chunks from "../db/chunks.js";
import * as jobs from "../db/jobs.js";
import { publishDocumentVersion } from "../db/ingestion.js";

// How many children go into one embedding request + one INSERT, and how many
// of those groups are in flight at once for ONE document. The separate global
// embedding limiter (concurrencyLimiter.js) bounds actual API concurrency
// across ALL documents a worker is running.
const EMBED_GROUP_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || "20", 10) * 2;
const GROUP_CONCURRENCY = parseInt(process.env.PAGE_CONCURRENCY || "3", 10);
const REUSED_INSERT_BATCH = 200;

// The API's local staging copy from multer. Only lives until it is in S3.
const deleteTempFile = async (filePath, log) => {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
    log?.(`temp file deleted: ${filePath}`);
  } catch (err) {
    if (err.code !== "ENOENT") logger.error(`Failed to delete temp file ${filePath}`, err);
  }
};

// The durable copy in S3. `document.tempFilePath` holds its object key.
const deleteStoredFile = async (key, log) => {
  if (!key) return;
  try {
    await storage.remove(key);
    log?.(`stored file deleted: ${key}`);
  } catch (err) {
    logger.error(`Failed to delete stored file ${key}`, err);
  }
};

const inBatches = (items, size) => {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
};

/**
 * Runs `worker` over `items` with at most `limit` in flight. Never rejects: a
 * worker handles its own failure so one bad group cannot abort the others.
 */
const runWithConcurrency = async (items, limit, worker) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    })
  );
};

// A Word file has no pages; its chunks carry page_from = null and are tracked
// against one pseudo-page for progress accounting.
const pageOf = (child) => child.pageFrom ?? 1;

const extractBlocks = (kind, buffer) => {
  if (kind === "pdf") return extractDocumentBlocks(buffer);
  if (kind === "docx") return extractDocxBlocks(buffer);
  if (isImageKind(kind)) return extractImageBlocks(buffer);
  throw Object.assign(new Error(unsupportedTypeMessage(null)), { status: 400 });
};

/**
 * The RAG stage: parse the file (PDF or Word) into structure, chunk it into
 * parents and children, embed the children, store both, and publish.
 *
 * The whole document version is rebuilt on every run, because a parent
 * (a heading section) spans pages and cannot be redone page by page. Retries
 * stay cheap anyway: children whose text was already embedded — by an earlier
 * failed attempt or an earlier version — reuse their stored vector.
 *
 * All-or-nothing publish: if ANY group of children fails to embed, nothing is
 * published, so retrieval never serves half a manual (a procedure whose
 * warning is missing is worse than a document that is not searchable yet). The
 * previous live version, if any, stays live until a complete replacement exists.
 */
const runRagStage = async ({ document, buffer, fileName, log }) => {
  const docId = document.docId;

  const kind = kindOfFileName(fileName);
  const extraction = await withTiming(`[ingest ${docId}] extract ${kind} structure`, () => extractBlocks(kind, buffer));
  const { totalPages, pages } = extraction;
  log(`${describeKind(kind)}: ${kind === "pdf" ? `${totalPages} pages, ` : ""}${extraction.blocks.length} structural blocks`);

  await documentPages.ensurePages(docId, pages.map((p) => p.pageNumber));
  await documentPages.resetPagesForRun(
    docId,
    pages.map((p) => ({ pageNumber: p.pageNumber, hasVisual: p.hasVisualContent }))
  );

  // Diagrams, photos, charts and tables: screenshot -> vision model -> description text,
  // inserted as blocks so it is chunked and embedded like everything else. Never fails the
  // document; pages it could not describe are marked below so a retry redoes only those.
  const version = document.liveVersion + 1;
  const enrichment = await withTiming(`[ingest ${docId}] describe visuals`, () =>
    enrichWithVisuals({ kind, buffer, extraction, fileName, docId, version, log })
  );
  const blocks = enrichment.blocks;

  const params = await loadChunkParams();
  const { parents, children } = await withTiming(`[ingest ${docId}] buildChunkTree`, () =>
    buildChunkTree(blocks, fileName, params)
  );
  log(`chunk plan: ${parents.length} parent section(s), ${children.length} child chunk(s)`);

  if (children.length === 0) {
    // No text layer (scanned pages) or nothing extractable. Every page is
    // accounted for; the caller turns "no chunks" into a failed document.
    await documentPages.completePages(docId, pages.map((p) => p.pageNumber));
    return { totalPages, version: null, published: false };
  }

  // Reuse vectors already computed for identical text; drop any half-written
  // rows from an earlier attempt at this same (never-published) version.
  const reusable = await chunks.loadReusableEmbeddings(docId, EMBEDDING_MODEL);
  await chunks.clearUnpublishedVersion(docId, version);
  const parentIdByKey = await chunks.insertParents(docId, version, parents);

  // Every description was already saved as it arrived; this saves the rest (cache hits carried over
  // from an earlier version, and "decorative" results so those are not asked again). Never deleted:
  // they are the cache a retry reads. They go live with this version, in publish_document_version().
  await figures.insertFigures(docId, version, enrichment.figures);

  const prepared = children.map((child) => ({
    ...child,
    metadata: { ...child.metadata, embedding_model: EMBEDDING_MODEL, source_file: fileName },
  }));
  const reused = [];
  const toEmbed = [];
  for (const child of prepared) {
    const vector = reusable.get(chunks.hashText(child.text));
    if (vector) reused.push({ ...child, embedding: vector });
    else toEmbed.push(child);
  }
  log(`children: ${reused.length} reuse a stored vector, ${toEmbed.length} to embed`);

  // Progress accounting: a page is complete when every child STARTING on it is stored.
  const pendingByPage = new Map();
  for (const child of children) pendingByPage.set(pageOf(child), (pendingByPage.get(pageOf(child)) ?? 0) + 1);
  const failedPages = new Set();

  await documentPages.completePages(
    docId,
    pages.map((p) => p.pageNumber).filter((n) => !pendingByPage.has(n))
  );

  const settle = async (group, error) => {
    const groupPages = [...new Set(group.map(pageOf))];

    if (error) {
      groupPages.forEach((n) => failedPages.add(n));
      logger.error(`[ingest ${docId}] ${group.length} chunk(s) failed to embed/store (page(s) ${groupPages.join(", ")})`, error);
      await documentPages.failPages(docId, groupPages, error.message || "Unknown embedding error");
      return;
    }

    const finished = [];
    for (const child of group) {
      const left = pendingByPage.get(pageOf(child)) - 1;
      pendingByPage.set(pageOf(child), left);
      if (left === 0 && !failedPages.has(pageOf(child))) finished.push(pageOf(child));
    }
    await documentPages.completePages(docId, finished);
  };

  for (const batch of inBatches(reused, REUSED_INSERT_BATCH)) {
    try {
      await chunks.insertChildren(docId, version, batch, parentIdByKey);
      await settle(batch, null);
    } catch (err) {
      await settle(batch, err);
    }
  }

  await runWithConcurrency(inBatches(toEmbed, EMBED_GROUP_SIZE), GROUP_CONCURRENCY, async (group) => {
    try {
      const embeddings = await generateEmbeddings(group.map((c) => c.text));
      await chunks.insertChildren(
        docId,
        version,
        group.map((child, i) => ({ ...child, embedding: embeddings[i] })),
        parentIdByKey
      );
      await settle(group, null);
    } catch (err) {
      await settle(group, err);
    }
  });

  let published = false;
  if (failedPages.size === 0) {
    await publishDocumentVersion(docId, version);
    published = true;
    log(`published version ${version} (${children.length} chunks live under ${parents.length} sections)`);
  } else {
    log(`NOT published: ${failedPages.size} page(s) failed — version ${version} stays pending until a retry succeeds`);
  }

  // Text is searchable either way, but a page whose diagrams/tables could not be described is
  // marked failed so the document shows "Needs retry" and the retry redoes only those pages
  // (every description that did succeed is served from the cache).
  if (enrichment.failedPages.length > 0) {
    await documentPages.failPages(docId, enrichment.failedPages, "Diagram or table description failed — retry to describe it");
  }

  return { totalPages, version, published };
};

/**
 * The actual work — called ONLY by the worker (src/worker.js), never
 * synchronously from an HTTP handler. Runs RAG processing + WorkDrive
 * archival (only if not already done) for a document, and finalizes its
 * status. Shared by both a fresh upload's job and a retry's job.
 */
export const processDocument = async (document) => {
  const log = (msg) => logger.info(`[ingest ${document.docId}] ${msg}`);
  const documentStart = Date.now();

  if (!document.tempFilePath) {
    throw new Error(`Document ${document.docId} has no tempFilePath — cannot process without the original bytes`);
  }

  const buffer = await storage.getBuffer(document.tempFilePath);
  const fileName = document.title;

  await documents.updateIngestState(document.docId, { ingestStatus: "rag_processing" });

  // A retry whose only outstanding work is the WorkDrive archive must not
  // rebuild a version that is already live and complete.
  const existingPages = await documentPages.findPagesByDoc(document.docId);
  const ragAlreadyDone =
    document.liveVersion > 0 && existingPages.length > 0 && existingPages.every((p) => p.status === "completed");

  let totalPages = document.pageCount ?? existingPages.length;
  if (ragAlreadyDone) {
    log(`version ${document.liveVersion} already live and complete -> skipping RAG stage`);
  } else {
    ({ totalPages } = await runRagStage({ document, buffer, fileName, log }));
  }

  const finalPageRows = await documentPages.findPagesByDoc(document.docId);
  const completedPages = finalPageRows.filter((r) => r.status === "completed");
  const failedPages = finalPageRows.filter((r) => r.status === "failed");
  const chunksCreated = await chunks.countChunks(document.docId);
  // A failed page can mean "text not searchable yet" (embedding failed, nothing published) or
  // "text is live but its diagrams could not be described". The admin needs to know which.
  const searchable = ((await documents.findById(document.docId))?.liveVersion ?? 0) > 0;

  // WorkDrive only after RAG processing, and only if not already archived —
  // a retry with an external_ref already set skips straight past this.
  let workdriveFileId = document.externalRef?.startsWith("upload:") ? null : document.externalRef;
  if (!workdriveFileId && chunksCreated > 0) {
    await documents.updateIngestState(document.docId, { ingestStatus: "workdrive_uploading" });
    try {
      const result = await uploadOriginalFile(buffer, fileName, document.docId);
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
  if (chunksCreated === 0) {
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
      chunksCreated === 0
        ? isImageKind(kindOfFileName(fileName))
          ? "Nothing recognizable was found in this image, or image description is turned off. Upload a clearer image."
          : kindOfFileName(fileName) === "pdf"
            ? "No extractable text — the PDF looks scanned (no text layer). Upload a text-searchable version; OCR is not enabled."
            : "No text was found in this document. Make sure it contains text (not only images) and upload it again."
        : failedPages.length > 0
          ? searchable
            ? `Page(s) ${failedPages.map((p) => p.pageNumber).join(", ")}: diagrams or tables could not be described. The text is searchable; retry to describe them.`
            : `Failed page(s): ${failedPages.map((p) => p.pageNumber).join(", ")} — not published until a retry succeeds`
          : !workdriveFileId
            ? "WorkDrive upload pending/failed — retry to complete archival"
            : null,
  });

  if (canDeleteTempFile) {
    await deleteStoredFile(document.tempFilePath, log);
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
 * the PDF, embed, or touch WorkDrive — all of that happens later in the
 * worker. This is what lets POST /api/documents/upload return 202
 * immediately regardless of document size.
 */
export const enqueueIngestion = async ({ filePath, fileName }) => {
  const kind = kindOfFileName(fileName);
  if (!kind) {
    await deleteTempFile(filePath);
    throw Object.assign(new Error(unsupportedTypeMessage(fileName)), { status: 400 });
  }

  const buffer = await fs.readFile(filePath);

  // Catch a renamed or corrupt file now, in the request, instead of after
  // several failed background attempts.
  if (!bufferMatchesKind(buffer, kind)) {
    await deleteTempFile(filePath);
    throw Object.assign(new Error(`"${fileName}" is not a valid ${describeKind(kind)} (the file contents do not match its type).`), { status: 400 });
  }

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  // Dedup: identical bytes already ingested, or still being ingested -> skip
  // creating a new document/job entirely (see findByContentHash).
  const existing = await documents.findByContentHash(sha256);

  if (existing) {
    logger.info(`[upload] duplicate (sha256 match) -> reusing document ${existing.docId}`);
    await deleteTempFile(filePath);
    return { documentId: existing.docId, status: existing.ingestStatus, duplicate: true };
  }

  // Hand the bytes to the worker through S3: it may be a different container with its own disk.
  const key = `${storage.UPLOAD_PREFIX}${path.basename(filePath)}`;
  try {
    await storage.putFile(key, filePath, mimeOfKind(kind));
  } catch (err) {
    await deleteTempFile(filePath);
    logger.error(`[upload] could not store "${fileName}" in S3`, err);
    throw Object.assign(new Error("Could not store the uploaded file. Try again."), { status: 502 });
  }
  await deleteTempFile(filePath);

  let document;
  try {
    document = await documents.createDocument({ title: fileName, contentHash: sha256, tempFilePath: key });
  } catch (err) {
    await deleteStoredFile(key);
    throw err;
  }
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
      "The original file is no longer available for retry (already archived or cleared). Please re-upload it."
    );
    err.status = 410;
    throw err;
  }

  if (!(await storage.exists(document.tempFilePath))) {
    const err = new Error(
      `The stored original (${document.tempFilePath}) is missing — cannot retry without the original bytes. Please re-upload.`
    );
    err.status = 410;
    throw err;
  }

  await documents.updateIngestState(document.docId, { ingestStatus: "queued" });
  const job = await jobs.createJob({ jobType: "process_document", docId: document.docId });

  logger.info(`[retry] document ${document.docId} re-queued (job ${job.id})`);

  return { documentId: document.docId, jobId: job.id, status: "queued" };
};

/**
 * Deletes a document for good: its chunks and vectors and every other row derived
 * from it (one DB transaction), then the S3 copy and the WorkDrive original.
 * The database goes first: once it commits the document can no longer be
 * searched or cited, so a failure cleaning up files afterwards leaves no visible
 * trace and comes back as a warning instead of an error.
 */
export const deleteDocument = async (docId) => {
  const removed = await documents.deleteDocumentData(docId);
  if (!removed) {
    throw Object.assign(new Error("Document not found"), { status: 404 });
  }

  const warnings = [];

  if (removed.tempFilePath) {
    try {
      await storage.remove(removed.tempFilePath);
    } catch (err) {
      logger.error(`[delete ${docId}] could not remove S3 copy ${removed.tempFilePath}`, err);
      warnings.push("The temporary upload copy could not be removed from S3.");
    }
  }

  try {
    const stored = await storage.list(storage.figurePrefixOf(docId));
    await Promise.all(stored.map(({ key }) => storage.remove(key)));
  } catch (err) {
    logger.error(`[delete ${docId}] could not remove figure images under ${storage.figurePrefixOf(docId)}`, err);
    warnings.push("Some stored diagram images could not be removed from S3.");
  }

  if (removed.externalRef && !removed.externalRef.startsWith("upload:")) {
    try {
      await deleteOriginalFile(removed.externalRef);
    } catch (err) {
      logger.error(`[delete ${docId}] could not trash WorkDrive file ${removed.externalRef}`, err);
      warnings.push("The archived original could not be removed from WorkDrive. Delete it there manually.");
    }
  }

  logger.info(
    `[delete ${docId}] "${removed.title}" deleted (${removed.chunks} chunks, ${removed.images} figures)` +
      (warnings.length ? ` with ${warnings.length} warning(s)` : "")
  );

  return { documentId: docId, title: removed.title, chunks: removed.chunks, images: removed.images, warnings };
};
