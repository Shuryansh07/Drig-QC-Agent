import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";

// Uploaded PDFs are streamed straight to disk instead of held fully in Node's
// memory — matters once files get larger than a few MB. The temp file is not
// permanent storage: it's deleted once RAG processing + WorkDrive upload both
// succeed (see ragIngestion.service.js), and any file that's still here after
// that either failed and is retryable, or was abandoned by a crash — either
// way, the worker's startup sweep cleans up anything genuinely orphaned.
//
// MUST be resolved to an absolute path: multer stores the absolute path of
// the file it writes into `documents.temp_file_path`, and the worker's
// orphan-cleanup sweep compares that DB value against paths it builds from
// this constant. If TEMP_UPLOAD_DIR were left relative (e.g. from a relative
// value in .env), that comparison would never match — the sweep would treat
// every file as "unreferenced" and delete files still needed by an
// in-progress or retryable document. (Found this the hard way — see the
// ENOENT on a still-referenced temp file during a real retry.)
export const TEMP_UPLOAD_DIR = path.resolve(process.env.TEMP_UPLOAD_DIR || path.join(process.cwd(), ".tmp", "uploads"));

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB — raised now that files stream to disk, not RAM
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

export default upload;
