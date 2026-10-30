import express from "express";
import upload from "../middleware/audio.middleware.js";
import { speakText, transcribeAudioFile } from "../controllers/audio.controller.js";

const router = express.Router();

// A rejected clip (wrong type, too large) is the client's mistake: answer 400 with the reason, not a 500.
const acceptAudio = (req, res, next) =>
  upload.single("audio")(req, res, (err) => {
    if (!err) return next();
    return res.status(400).json({ success: false, message: err.message });
  });

router.post("/transcribe", acceptAudio, transcribeAudioFile);
router.post("/speech", speakText);

export default router;
