import crypto from "node:crypto";
import * as wiring from "../db/drigWiring.js";
import { createJob } from "../db/jobs.js";
import { putObject } from "../services/wiring/wiringBuckets.js";
import { DRIG_WIRING_JOB, parseWiringWorkbook, WorkbookFormatError } from "../services/wiring/drigWiringImport.service.js";
import { vehicleOptions } from "../services/wiring/wiringLookup.service.js";
import { logger } from "../utils/logger.js";

const isZip = (buffer) => buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;

/** "Vehicle wiring guide April 2026 (1).xlsx" -> a safe S3 key segment. */
const safeName = (name) =>
  String(name ?? "guide.xlsx")
    .normalize("NFKD")
    .replace(/[^\w.() -]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim() || "guide.xlsx";

const toWire = (i) => ({
  import_id: i.importId,
  file_name: i.fileName,
  status: i.status,
  stage: i.stage,
  counts: i.counts,
  error: i.error,
  is_live: i.isLive,
  created_at: i.createdAt,
  started_at: i.startedAt,
  finished_at: i.finishedAt,
});

/**
 * POST /api/wiring/imports (multipart, field "file", .xlsx) — DRIG's vehicle
 * wiring guide. Stores the workbook in the DRIG wiring bucket and queues the
 * import; the worker parses it, follows its links and publishes it. 202, or
 * 200 { duplicate } when the same workbook is already live or importing.
 */
export const uploadWiringGuide = async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: "An Excel workbook (.xlsx) is required (multipart field name: file)" });
    if (!/\.xlsx$/i.test(file.originalname)) {
      return res.status(400).json({ success: false, message: "Only Excel workbooks (.xlsx) can be imported as the wiring guide." });
    }
    if (!isZip(file.buffer)) {
      return res.status(400).json({ success: false, message: `"${file.originalname}" is not a valid .xlsx workbook (the file contents do not match).` });
    }

    // Under a second for the real guide: a workbook that is not the wiring guide is refused now, with the reason,
    // instead of being queued and failing in the worker.
    try {
      await parseWiringWorkbook(file.buffer);
    } catch (err) {
      if (err instanceof WorkbookFormatError) return res.status(400).json({ success: false, message: err.message });
      throw err;
    }

    const contentHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const existing = await wiring.findActiveImportByHash(contentHash);
    if (existing) {
      return res.status(200).json({ duplicate: true, import: toWire(existing), message: "This exact workbook is already the live guide (or is being imported)." });
    }

    const fileName = safeName(file.originalname);
    const s3Key = `imports/${contentHash}/${fileName}`;
    try {
      await putObject("drig_wiring", s3Key, file.buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (err) {
      logger.error("[wiring] could not store the uploaded workbook", err);
      return res.status(502).json({ success: false, message: "Could not store the workbook. Try again." });
    }

    const created = await wiring.createImport({ fileName, contentHash, s3Key });
    const job = await createJob({ jobType: DRIG_WIRING_JOB, docId: null, payload: { importId: created.importId, source: "drig-wiring" } });
    logger.info(`[wiring] guide "${fileName}" queued as import ${created.importId} (job ${job.id})`);
    return res.status(202).json({ import: toWire(created), job_id: job.id, message: "Wiring guide accepted for import" });
  } catch (error) {
    logger.error("[wiring] upload failed", error);
    return res.status(500).json({ success: false, message: "Failed to accept the wiring guide" });
  }
};

/** GET /api/wiring/imports — recent imports, newest first, with progress counts. Polled by the admin panel. */
export const listWiringImports = async (_req, res) => {
  try {
    return res.status(200).json({ imports: (await wiring.listImports(10)).map(toWire) });
  } catch (error) {
    logger.error("[wiring] listing imports failed", error);
    return res.status(500).json({ success: false, message: "Failed to load wiring guide imports" });
  }
};

/**
 * GET /api/wiring/vehicle-options[?make=] — for the chat's vehicle picker.
 * Without make: every make the DRIG guide or Wiresheet covers. With make: its
 * models, each with the years and start types either source has.
 */
export const getVehicleOptions = async (req, res) => {
  try {
    const make = typeof req.query.make === "string" ? req.query.make.trim().slice(0, 60) : "";
    return res.status(200).json(await vehicleOptions({ make: make || undefined }));
  } catch (error) {
    logger.error("[wiring] vehicle options failed", error);
    return res.status(500).json({ success: false, message: "Failed to load vehicles" });
  }
};
