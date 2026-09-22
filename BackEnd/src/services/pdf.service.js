import { PDFParse } from "pdf-parse";

/**
 * Plain-text extraction for the standalone POST /api/pdf/upload endpoint.
 * Document ingestion does NOT use this: it needs headings, columns and
 * procedures, which flat text can't carry — see chunking/pdfStructure.js.
 */
export const extractPdfText = async (buffer) => {
  const parser = new PDFParse({
    data: buffer,
  });

  const result = await parser.getText();

  await parser.destroy();

  return result.text;
};
