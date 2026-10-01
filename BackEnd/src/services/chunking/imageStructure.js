/**
 * Turns a standalone image upload (jpg/png — a photo of a label, a wiring diagram,
 * a nameplate, with no surrounding manual) into the same structural-block shape
 * pdfStructure.js and docxStructure.js produce, so chunking, embedding, publishing
 * and retrieval are all shared code, not a parallel path.
 *
 * An image carries no text of its own — unlike a PDF or Word file, there is
 * nothing to extract here. The whole "structure" is one page with no blocks;
 * visualEnrichment.js's enrichImage() sends the full image to the vision model
 * and inserts its description as the page's one `figure` block. If vision is
 * disabled, or the image has nothing describable, the document ends up with
 * zero blocks and fails the normal "no extractable text" path.
 *
 * @returns {{ totalPages: number, pages: object[], blocks: object[] }}
 */
export const extractImageBlocks = (buffer) => ({
  totalPages: 1,
  pages: [{ pageNumber: 1, hasVisualContent: true, hasText: false }],
  blocks: [],
});
