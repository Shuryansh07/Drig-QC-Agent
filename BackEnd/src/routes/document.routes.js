import express from "express";
import upload from "../middleware/upload.middleware.js";
import {
  uploadDocument,
  listDocumentsController,
  retryDocumentController,
  getDocumentStatus,
  deleteDocumentController,
  syncDriveController,
  scanDriveController,
  stopDriveSyncController,
  driveSyncStatusController,
} from "../controllers/document.controller.js";

const router = express.Router();

router.get("/", listDocumentsController);
router.post("/upload", upload.single("file"), uploadDocument);
router.get("/sync-drive", driveSyncStatusController);
router.post("/sync-drive", syncDriveController);
router.post("/sync-drive/scan", scanDriveController);
router.post("/sync-drive/stop", stopDriveSyncController);
router.post("/:id/retry", retryDocumentController);
router.get("/:id/status", getDocumentStatus);
router.delete("/:id", deleteDocumentController);

export default router;
