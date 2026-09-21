import { PDFParse } from "pdf-parse";
import { withTiming } from "../utils/timing.js";
import { logger } from "../utils/logger.js";

export const extractPdfText = async (buffer) => {
  const parser = new PDFParse({
    data: buffer,
  });

  const result = await parser.getText();

  await parser.destroy();

  return result.text;
};

/**
 * Parses a PDF buffer page-by-page: extracted text for every page, plus a
 * cheap (no-LLM) flag for whether the page contains an embedded image.
 *
 * Vision LLM processing of visual pages was removed — every page is now
 * ingested from its extracted text directly, the same as a plain-text page.
 * `hasVisualContent` is kept as informational metadata only (still recorded
 * on document_pages / document_chunks) so this is a one-line revert if
 * Vision is ever turned back on; it no longer triggers anything by itself,
 * and page snapshot rendering (the actual expensive step) was removed
 * entirely since nothing consumes it anymore.
 *
 * Never touches disk — `buffer` lives only in process memory for the
 * duration of the request.
 */
export const parsePdfPages = async (buffer) => {
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await withTiming("pdf-parse getText (all pages)", () => parser.getText());
    const totalPages = textResult.total;

    if (!totalPages || totalPages < 1) {
      throw new Error("PDF has no pages");
    }

    // Cheap, no-LLM detection of "page contains image/visual" — uses
    // pdf-parse's embedded-image extraction (default imageThreshold: 80px
    // already filters out tiny icons/logos). Informational only.
    let imageResult;
    try {
      imageResult = await withTiming("pdf-parse getImage (all pages)", () => parser.getImage());
    } catch (err) {
      logger.error("Embedded-image detection failed for the document", err);
      imageResult = { pages: [] };
    }

    const visualPageSet = new Set(
      imageResult.pages.filter((p) => p.images && p.images.length > 0).map((p) => p.pageNumber)
    );

    const pages = textResult.pages.map((pageText) => ({
      pageNumber: pageText.num,
      text: (pageText.text ?? "").trim(),
      hasVisualContent: visualPageSet.has(pageText.num),
    }));

    return { totalPages, pages };
  } finally {
    await parser.destroy();
  }
};
