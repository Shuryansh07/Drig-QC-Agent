import express from "express";
import upload from "../middleware/upload.middleware.js";
import {
  uploadDocument,
  retryDocumentController,
  getDocumentStatus,
} from "../controllers/document.controller.js";

const router = express.Router();

router.post("/upload", upload.single("file"), uploadDocument);
router.post("/:id/retry", retryDocumentController);
router.get("/:id/status", getDocumentStatus);

export default router;
