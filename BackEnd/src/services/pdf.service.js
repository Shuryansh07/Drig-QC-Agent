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
 * rendered page snapshot (PNG, in memory only, never persisted) for pages
 * that actually contain an embedded image/diagram/chart — text-only pages
 * skip rendering entirely, which is both cheaper and what lets ingestion
 * skip the Vision LLM call for the majority of typical pages.
 *
 * Never touches disk — `buffer` lives only in process memory for the
 * duration of the request.
 */
export const parsePdfPages = async (buffer, { screenshotScale = 2 } = {}) => {
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await withTiming("pdf-parse getText (all pages)", () => parser.getText());
    const totalPages = textResult.total;

    if (!totalPages || totalPages < 1) {
      throw new Error("PDF has no pages");
    }

    // Cheap, no-LLM detection of "page contains image/visual" — uses
    // pdf-parse's embedded-image extraction (default imageThreshold: 80px
    // already filters out tiny icons/logos).
    let imageResult;
    try {
      imageResult = await withTiming("pdf-parse getImage (all pages)", () => parser.getImage());
    } catch (err) {
      logger.error("Embedded-image detection failed for the document", err);
      imageResult = { pages: [] };
    }

    const visualPageNumbers = imageResult.pages
      .filter((p) => p.images && p.images.length > 0)
      .map((p) => p.pageNumber);

    let screenshotResult = { pages: [] };
    if (visualPageNumbers.length > 0) {
      try {
        screenshotResult = await withTiming(
          `pdf-parse getScreenshot (${visualPageNumbers.length}/${totalPages} visual pages, scale ${screenshotScale})`,
          () =>
            parser.getScreenshot({
              partial: visualPageNumbers,
              scale: screenshotScale,
              imageBuffer: true,
              imageDataUrl: false,
            })
        );
      } catch (err) {
        logger.error("Page snapshot rendering failed for the document", err);
        screenshotResult = { pages: [] };
      }
    }

    const visualPageSet = new Set(visualPageNumbers);

    const pages = textResult.pages.map((pageText) => {
      const hasVisualContent = visualPageSet.has(pageText.num);
      const screenshot = screenshotResult.pages.find((p) => p.pageNumber === pageText.num);

      return {
        pageNumber: pageText.num,
        text: (pageText.text ?? "").trim(),
        hasVisualContent,
        imageBuffer: screenshot?.data ? Buffer.from(screenshot.data) : null,
        width: screenshot?.width ?? null,
        height: screenshot?.height ?? null,
      };
    });

    return { totalPages, pages };
  } finally {
    await parser.destroy();
  }
};
