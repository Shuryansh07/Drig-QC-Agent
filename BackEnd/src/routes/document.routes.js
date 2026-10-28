import express from "express";
import upload from "../middleware/upload.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import {
  uploadDocument,
  listDocumentsController,
  retryDocumentController,
  getDocumentStatus,
  deleteDocumentController,
  setDocumentCollectionController,
  syncDriveController,
  scanDriveController,
  stopDriveSyncController,
  driveSyncStatusController,
} from "../controllers/document.controller.js";

const router = express.Router();

// Reads stay open (the admin panel polls them). Everything that changes the
// knowledge base needs the admin token when ADMIN_API_TOKEN is set.
router.get("/", listDocumentsController);
router.post("/upload", requireAdmin, upload.single("file"), uploadDocument);
router.get("/sync-drive", driveSyncStatusController);
router.post("/sync-drive", requireAdmin, syncDriveController);
router.post("/sync-drive/scan", requireAdmin, scanDriveController);
router.post("/sync-drive/stop", requireAdmin, stopDriveSyncController);
router.post("/:id/retry", requireAdmin, retryDocumentController);
router.patch("/:id/collection", requireAdmin, setDocumentCollectionController);
router.get("/:id/status", getDocumentStatus);
router.delete("/:id", requireAdmin, deleteDocumentController);

export default router;
