import crypto from "node:crypto";
import { PDFParse } from "pdf-parse";
import { describeVisual, figureModelTag } from "../vision.service.js";
import { loadVisualParams } from "./visualParams.js";
import { loadFigureCache, insertFigures } from "../../db/images.js";
import { logger } from "../../utils/logger.js";
import { mimeOfKind } from "./documentTypes.js";
import * as storage from "../storage.service.js";

/**
 * Diagrams, photos, charts and tables are pictures as far as text extraction is
 * concerned: a wiring diagram yields a scatter of labels with no meaning, and a
 * table's cells come out in the wrong order. This step screenshots them, has a
 * vision model describe them in words, and inserts that description into the
 * document as a `figure` block, so it is chunked, embedded and searched like any
 * other text.
 *
 * What a description IS: a machine-written aid for finding and understanding the
 * figure. What it is NOT: the manual's own words. Every figure block carries that
 * label all the way to the answer model (chunker.js renders it, answerGeneration
 * tells the model not to state a wire, pin or value from it as fact). The extracted
 * text of a table stays alongside its description; the two are never merged, so
 * the exact printed strings remain available for checking.
 *
 * Nothing here may fail a document: a picture that cannot be described costs that
 * page its description, is reported, and is retried later from the cache.
 */

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/**
 * Save a description the moment the model returns it. Each one costs money and
 * seconds; if the job later fails (a database error, a crash, a worker restart)
 * everything already saved is served from the cache on the next attempt instead of
 * being paid for again. Best-effort: the full set is saved again at the end.
 */
const saveNow = async ({ docId, version }, record) => {
  try {
    await insertFigures(docId, version, [record]);
  } catch (err) {
    logger.error("[vision] could not save a description as it arrived (it will be saved with the rest)", err);
  }
};

/**
 * Keep the picture itself, so the answer model can look at the drawing when a
 * question lands on it (answerGeneration.service.js). Only pictures that got a
 * description are kept; decorative ones are never shown. Best-effort: a picture
 * that could not be stored is still searchable through its description.
 */
const storeImage = async ({ docId }, { contentHash, buffer, mimeType }) => {
  const key = storage.figureKey(docId, contentHash, mimeType);
  try {
    await storage.putBuffer(key, buffer, mimeType);
    return key;
  } catch (err) {
    logger.error(`[vision] could not store figure image ${key} (answers will use its description only)`, err);
    return null;
  }
};

const blockText = (block) => {
  if (block.type === "list") return block.items.map((i) => `${i.marker} ${i.text}`).join(" ");
  return block.text ?? "";
};

// ---- PDF ---------------------------------------------------------------------

/**
 * Which pages need a vision pass, and why. A page qualifies if it has a real
 * embedded image, a figure caption, enough vector drawing to be a diagram, or a
 * table. Text-only pages are never sent.
 */
export const planPdfVisuals = (pages, blocks, params) => {
  const plan = [];

  for (const page of pages) {
    const reasons = [];
    const { imageMinDims = [], pathOps = 0 } = page.signals ?? {};

    if (imageMinDims.some((d) => d >= params.minImagePx)) reasons.push("image");
    if (blocks.some((b) => b.type === "caption" && b.page === page.pageNumber) || pathOps >= params.minVectorOps) reasons.push("diagram");
    if (blocks.some((b) => b.type === "table" && b.page === page.pageNumber)) reasons.push("table");

    if (reasons.length > 0) plan.push({ page: page.pageNumber, reasons });
  }

  return plan;
};

/** Puts a block after the last block on `page`, or where the page would be if it has no text. */
const insertAfterPage = (blocks, page, block) => {
  let index = -1;
  blocks.forEach((b, i) => {
    if (b.page === page) index = i;
  });
  if (index === -1) {
    const later = blocks.findIndex((b) => b.page > page);
    index = later === -1 ? blocks.length - 1 : later - 1;
  }
  blocks.splice(index + 1, 0, block);
};

const enrichPdf = async ({ buffer, extraction, fileName, cache, params, log, save, checkpoint }) => {
  const { pages } = extraction;
  const blocks = [...extraction.blocks];

  const plan = planPdfVisuals(pages, blocks, params);
  const chosen = plan.slice(0, params.maxVisualsPerDocument);
  if (plan.length > chosen.length) {
    log(`vision: ${plan.length} pages need it, cap is ${params.maxVisualsPerDocument} — ${plan.length - chosen.length} later page(s) skipped (raise vision.max_visuals_per_document)`);
  }
  if (chosen.length === 0) return { blocks, figures: [], failedPages: [] };

  // One parse of the file for every page we need, not one per page.
  const parser = new PDFParse({ data: buffer });
  let screenshots;
  try {
    screenshots = await parser.getScreenshot({
      partial: chosen.map((c) => c.page),
      scale: params.pageRenderScale,
      imageBuffer: true,
      imageDataUrl: false,
    });
  } finally {
    await parser.destroy();
  }
  const pngByPage = new Map(screenshots.pages.map((p) => [p.pageNumber, Buffer.from(p.data)]));

  const figures = [];
  const failedPages = [];
  const results = new Map();
  const modelTag = figureModelTag();

  await Promise.all(
    chosen.map(async ({ page, reasons }) => {
      const png = pngByPage.get(page);
      if (!png) {
        failedPages.push(page);
        return;
      }

      const contentHash = sha256(png);
      let result = cache.get(contentHash);
      let fresh = false;

      if (!result) {
        await checkpoint?.(); // throws if the job was cancelled: no more paid vision calls
        try {
          const contextText = blocks.filter((b) => b.page === page && b.type !== "figure").map(blockText).join(" ");
          result = await describeVisual({
            imageBuffer: png,
            mimeType: "image/png",
            fileName,
            locator: `page ${page}`,
            reasons,
            contextText,
          });
        } catch (err) {
          logger.error(`[vision] page ${page} of "${fileName}" could not be described`, err);
          failedPages.push(page);
          return;
        }
        fresh = true;
      }

      const s3Key = result.description ? await storeImage(save, { contentHash, buffer: png, mimeType: "image/png" }) : null;
      const record = { page, contentHash, sourceKind: "pdf_page", visualType: result.visualType, description: result.description, modelTag, s3Key };
      figures.push(record);
      if (fresh) await saveNow(save, record);
      if (result.description) results.set(page, { ...result, contentHash });
    })
  );

  // Inserted in page order, after all the (slow) calls, so block positions never shift under a running task.
  for (const [page, result] of [...results.entries()].sort((a, b) => a[0] - b[0])) {
    insertAfterPage(blocks, page, {
      type: "figure",
      text: result.description,
      visualType: result.visualType,
      sourceKind: "pdf_page",
      imageHash: result.contentHash,
      page,
      pageEnd: page,
    });
  }

  return { blocks, figures, failedPages: failedPages.sort((a, b) => a - b) };
};

// ---- Word --------------------------------------------------------------------

const enrichDocx = async ({ extraction, fileName, cache, params, log, save, checkpoint }) => {
  const { images } = extraction;
  const placeholders = extraction.blocks.filter((b) => b.type === "figure");
  const chosen = new Set(placeholders.slice(0, params.maxVisualsPerDocument));
  if (placeholders.length > chosen.size) {
    log(`vision: ${placeholders.length} images, cap is ${params.maxVisualsPerDocument} — ${placeholders.length - chosen.size} skipped (raise vision.max_visuals_per_document)`);
  }

  const figures = [];
  const failedPages = [];
  const modelTag = figureModelTag();
  const described = new Map(); // placeholder -> result

  await Promise.all(
    [...chosen].map(async (block, n) => {
      const image = images[block.imageIndex];
      const contentHash = sha256(image.buffer);
      let result = cache.get(contentHash);
      let fresh = false;

      if (!result) {
        await checkpoint?.();
        try {
          const at = extraction.blocks.indexOf(block);
          const before = extraction.blocks.slice(0, at).filter((b) => b.type !== "figure").slice(-2).map(blockText).join(" ");
          result = await describeVisual({
            imageBuffer: image.buffer,
            mimeType: image.contentType,
            fileName,
            locator: `image ${n + 1}`,
            reasons: [],
            contextText: before,
          });
        } catch (err) {
          logger.error(`[vision] image ${n + 1} of "${fileName}" could not be described`, err);
          // A Word file is one tracked unit, so its failed figures fail page 1.
          if (!failedPages.includes(1)) failedPages.push(1);
          return;
        }
        fresh = true;
      }

      const s3Key = result.description ? await storeImage(save, { contentHash, buffer: image.buffer, mimeType: image.contentType }) : null;
      const record = { page: null, contentHash, sourceKind: "docx_image", visualType: result.visualType, description: result.description, modelTag, s3Key };
      figures.push(record);
      if (fresh) await saveNow(save, record);
      described.set(block, { ...result, contentHash });
    })
  );

  // Placeholders become described figure blocks in place; the rest (skipped, failed,
  // decorative) are removed so no empty block reaches the chunker.
  const blocks = extraction.blocks.flatMap((block) => {
    if (block.type !== "figure") return [block];
    const result = described.get(block);
    return result?.description
      ? [{ type: "figure", text: result.description, visualType: result.visualType, sourceKind: "docx_image", imageHash: result.contentHash, page: null, pageEnd: null }]
      : [];
  });

  return { blocks, figures, failedPages };
};

// ---- standalone image upload ---------------------------------------------------

/**
 * A jpg/png uploaded on its own, not inside a PDF or Word file — there is no
 * page to screenshot and no surrounding text for context; the whole buffer IS
 * the one image, sent to the vision model as-is. Mirrors enrichDocx's single-
 * image case, with no pageMap or placeholder scanning needed.
 */
const enrichImage = async ({ buffer, fileName, kind, cache, params, log, save }) => {
  const contentHash = sha256(buffer);
  let result = cache.get(contentHash);
  let fresh = false;

  if (!result) {
    try {
      result = await describeVisual({
        imageBuffer: buffer,
        mimeType: mimeOfKind(kind),
        fileName,
        locator: "the uploaded image",
        reasons: ["standalone image upload"],
        contextText: "",
      });
    } catch (err) {
      logger.error(`[vision] "${fileName}" could not be described`, err);
      return { blocks: [], figures: [], failedPages: [1] };
    }
    fresh = true;
  }

  const s3Key = result.description ? await storeImage(save, { contentHash, buffer, mimeType: mimeOfKind(kind) }) : null;
  const record = { page: 1, contentHash, sourceKind: "image_upload", visualType: result.visualType, description: result.description, modelTag: figureModelTag(), s3Key };
  if (fresh) await saveNow(save, record);

  // Decorative or nothing recognizable: still cache the result (a retry shouldn't ask
  // again), but there is then no content at all — the document fails "no extractable
  // text" below, same as a scanned PDF page with nothing on it.
  if (!result.description) {
    log(`vision: "${fileName}" has nothing describable (${result.visualType})`);
    return { blocks: [], figures: [record], failedPages: [] };
  }

  const blocks = [
    { type: "figure", text: result.description, visualType: result.visualType, sourceKind: "image_upload", imageHash: contentHash, page: 1, pageEnd: 1 },
  ];
  return { blocks, figures: [record], failedPages: [] };
};

// ---- entry point -------------------------------------------------------------

/**
 * @returns {Promise<{ blocks: object[], figures: object[], failedPages: number[], described: number }>}
 *   `figures` are the records to persist (kb_image), including decorative results,
 *   which are cached so they are not asked about again. `failedPages` are the
 *   pages whose visuals could not be described; the caller marks them for retry.
 */
/** `checkpoint`, when given, is awaited before each vision call and throws to abandon the document (job cancelled). */
export const enrichWithVisuals = async ({ kind, buffer, extraction, fileName, docId, version, log, checkpoint }) => {
  const params = await loadVisualParams();

  if (!params.enabled) {
    log("vision: disabled (setting vision.enabled = false), ingesting text only");
    return { blocks: extraction.blocks.filter((b) => b.type !== "figure"), figures: [], failedPages: [], described: 0 };
  }

  const cache = await loadFigureCache(docId, figureModelTag());
  const args = { buffer, extraction, fileName, kind, cache, params, log, save: { docId, version }, checkpoint };
  const outcome = kind === "pdf" ? await enrichPdf(args) : kind === "docx" ? await enrichDocx(args) : await enrichImage(args);

  const described = outcome.blocks.filter((b) => b.type === "figure").length;
  log(
    `vision: ${described} visual(s) described, ${outcome.figures.filter((f) => !f.description).length} decorative/empty, ` +
      `${outcome.failedPages.length} failed, ${cache.size} cached result(s) available`
  );

  return { ...outcome, described };
};
