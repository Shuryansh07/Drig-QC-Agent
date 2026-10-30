import { MAX_SPEECH_CHARS, prepareSpeech, streamSpeech, transcribeAudio } from "../services/audio.service.js";

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

  return res.status(201).json({ id: prepareSpeech(text) });
};

/** An audio element can only GET, so the text is registered first (speakText) and this plays it by id. */
export const streamSpeechAudio = async (req, res) => {
  const stream = streamSpeech(req.params.id);
  if (!stream) {
    return res.status(404).json({ success: false, message: "Speech not found. Request it again." });
  }

  try {
    let started = false;
    for await (const chunk of stream) {
      if (res.destroyed) return;
      // Headers wait for the first audio, so a failed generation can still answer with an error status.
      if (!started) {
        res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        started = true;
      }
      if (!res.write(chunk)) await new Promise((resume) => res.once("drain", resume).once("close", resume));
    }
    return res.end();
  } catch (error) {
    console.error("Speech synthesis error:", error);
    if (res.headersSent) return res.destroy(error);
    return res.status(502).json({ success: false, message: "Failed to generate speech" });
  }
};
