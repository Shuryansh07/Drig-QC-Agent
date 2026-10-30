import { MAX_SPEECH_CHARS, synthesizeSpeech, transcribeAudio } from "../services/audio.service.js";

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

export const speakText = async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    return res.status(400).json({ success: false, message: "text is required" });
  }
  if (text.length > MAX_SPEECH_CHARS) {
    return res.status(400).json({ success: false, message: `text must be at most ${MAX_SPEECH_CHARS} characters` });
  }

  try {
    const audio = await synthesizeSpeech(text);
    res.set("Content-Type", "audio/mpeg");
    return res.send(audio);
  } catch (error) {
    console.error("Speech synthesis error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to generate speech",
    });
  }
};
