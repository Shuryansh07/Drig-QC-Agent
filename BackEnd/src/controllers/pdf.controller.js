import { extractPdfText } from "../services/pdf.service.js";

export const uploadPdf = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "PDF file is required",
      });
    }

    const text = await extractPdfText(req.file.buffer);

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
  } catch (error) {
    console.error("PDF processing error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to process PDF",
    });
  }
};