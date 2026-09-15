import express from "express";
import upload from "../middleware/audio.middleware.js";
import { transcribeAudioFile } from "../controllers/audio.controller.js";

const router = express.Router();

router.post("/transcribe", upload.single("audio"), transcribeAudioFile);

export default router;
