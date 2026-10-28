import express from "express";
import multer from "multer";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { uploadWiringGuide, listWiringImports, getVehicleOptions } from "../controllers/wiring.controller.js";

// The guide is a few hundred KB; held in memory (no temp file to clean up) and
// capped well above that. Name and contents are checked in the controller, after
// the body is read: rejecting mid-upload here drops the connection, and the
// admin would see a network error instead of the reason.
const MAX_WORKBOOK_BYTES = parseInt(process.env.DRIG_WIRING_MAX_UPLOAD_BYTES || String(25 * 1024 * 1024), 10);

const workbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_WORKBOOK_BYTES, files: 1, fields: 5 },
});

const router = express.Router();

router.get("/vehicle-options", getVehicleOptions);
router.get("/imports", requireAdmin, listWiringImports);
router.post("/imports", requireAdmin, workbookUpload.single("file"), uploadWiringGuide);

export default router;
