import express from "express";
import upload from "../middleware/upload.middleware.js";
import { uploadPdf } from "../controllers/pdf.controller.js";

const router = express.Router();

router.post("/upload", upload.single("pdf"), uploadPdf);

export default router;