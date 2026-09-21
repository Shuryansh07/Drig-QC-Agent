import { transcribeAudio } from "../services/audio.service.js";

export const transcribeAudioFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Audio file is required",
      });
    }

    const text = await transcribeAudio(req.file.buffer, req.file.originalname);

    return res.status(200).json({
      success: true,
      message: "Audio transcribed successfully",
      data: {
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        text,
      },
    });
  } catch (error) {
    console.error("Audio transcription error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to transcribe audio",
    });
  }
};
