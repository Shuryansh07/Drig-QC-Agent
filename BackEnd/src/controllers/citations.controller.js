import { findChunkAtLocation } from "../db/chunks.js";
import { findFigureImages } from "../db/images.js";
import * as storage from "../services/storage.service.js";
import { logger } from "../utils/logger.js";

/**
 * GET /api/citations/:ref — what the technician sees when they tap a citation
 * chip. `:ref` is the SAME synthetic key the chip was built from on the client
 * (useChatStream.ts's toCitations()): `${document_id}:${page_number}` for a
 * paged PDF, `${document_id}:${section_tail}` for a Word file's section. It is
 * not a real kb_chunk id — sourcesFromChunks() already collapsed possibly-
 * several matching chunks down to one entry per distinct location, so this
 * resolves the click back to a location, not a row (see findChunkAtLocation).
 */
export const getCitation = async (req, res) => {
  try {
    const { ref } = req.params;
    const sep = ref.indexOf(":");
    if (sep === -1) {
      return res.status(400).json({ success: false, message: "Malformed citation reference" });
    }

    const docId = ref.slice(0, sep);
    const locator = ref.slice(sep + 1);
    const page = /^\d+$/.test(locator) ? parseInt(locator, 10) : null;
    const sectionPath = page === null && locator !== "document" ? locator : null;

    const chunk = await findChunkAtLocation({ docId, page, sectionPath });
    if (!chunk) {
      return res.status(404).json({ success: false, message: "This passage is no longer available (the document may have been updated)" });
    }

    // Whatever figure (a diagram, a photo, a table) was described on this same
    // page, if any — the same evidence the answer itself would have attached.
    let imageUrl;
    if (chunk.pageFrom !== null) {
      try {
        const [figure] = await findFigureImages([{ docId, page: chunk.pageFrom }]);
        if (figure) imageUrl = await storage.getPresignedUrl(figure.s3Key);
      } catch (err) {
        logger.error(`[citations] could not resolve the figure image for ${docId} page ${chunk.pageFrom} (showing text only)`, err);
      }
    }

    return res.status(200).json({
      chunkId: ref,
      kind: "document",
      label: chunk.pageFrom !== null ? `Page ${chunk.pageFrom}` : chunk.documentTitle.replace(/\.(pdf|docx)$/i, ""),
      locator: chunk.sectionPath?.split(" > ").pop() ?? "",
      excerpt: chunk.content,
      documentId: docId,
      ...(imageUrl && { imageUrl }),
    });
  } catch (error) {
    logger.error("Citation lookup error", error);
    return res.status(500).json({ success: false, message: "Failed to load this source" });
  }
};
