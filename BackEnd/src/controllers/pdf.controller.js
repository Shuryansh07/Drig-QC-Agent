import fs from "node:fs/promises";
import { extractPdfText } from "../services/pdf.service.js";

export const uploadPdf = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "PDF file is required",
      });
    }

    try {
      const buffer = await fs.readFile(req.file.path);
      const text = await extractPdfText(buffer);

      return res.status(200).json({
        success: true,
        message: "PDF processed successfully",
        data: {
          fileName: req.file.originalname,
          fileSize: req.file.size,
          mimeType: req.file.mimetype,
          text,
        },
      });
    } finally {
      // Upload middleware now writes to a temp file (see upload.middleware.js) —
      // this route doesn't persist anything, so always clean up after itself.
      await fs.unlink(req.file.path).catch(() => {});
    }
  } catch (error) {
    console.error("PDF processing error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to process PDF",
    });
  }
};