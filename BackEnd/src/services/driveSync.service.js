import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TEMP_UPLOAD_DIR } from "../middleware/upload.middleware.js";
import { enqueueIngestion } from "./ragIngestion.service.js";
import { kindOfFileName, extensionOfKind, isImageKind } from "./chunking/documentTypes.js";
import { listUploadTitles } from "../db/documents.js";
import { logger } from "../utils/logger.js";

// Pulls documents from a Google Drive folder shared as "Anyone with the link"
// and feeds them through the same enqueueIngestion() the upload route uses.
// A link-shared folder is public, so an API key is all the Drive API needs —
// no service account, no access to the owner's account.
const API_BASE = "https://www.googleapis.com/drive/v3";
const API_KEY = process.env.GOOGLE_API_KEY;
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
// Older link-shared items (IDs starting "0B") also need the `resourcekey`
// from their share URL, or the API answers 404 even though the link works.
const FOLDER_RESOURCE_KEY = process.env.GDRIVE_RESOURCE_KEY;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// For trying the pipeline on a few files first: only the first N files of the
// folder (in listFiles' order) are ever synced. Unset or 0 = no limit.
const SYNC_LIMIT = parseInt(process.env.GDRIVE_SYNC_LIMIT || "0", 10) || Infinity;
// Off unless explicitly "true": a sync only starts from the admin panel's button.
const AUTO_SYNC = process.env.GDRIVE_AUTO_SYNC === "true";
const INTERVAL_MS = parseInt(process.env.GDRIVE_SYNC_INTERVAL_MS || "600000", 10);

// Google-native files have no bytes of their own; Drive exports them. PDF is
// the export to use: Drive renders identical bytes for an unchanged file, so
// the sha256 dedup in enqueueIngestion() still recognizes it on a later sync
// (DOCX/XLSX exports differ byte-for-byte every time).
const GOOGLE_EXPORTS = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
};

export const isDriveSyncConfigured = () => Boolean(API_KEY && FOLDER_ID);

// fileId -> modifiedTime of files already handed to enqueueIngestion, so a
// sync only downloads what is new or changed. In memory only: after a restart
// everything is downloaded once more, and the sha256 dedup in
// enqueueIngestion() turns the unchanged ones into no-ops.
const seen = new Map();

// Syncs that imported something, newest first, so the admin panel can show
// what every recent sync did. A sync that found nothing new is not kept —
// only its time, in lastNoChangeAt — so the 10-minute automatic syncs don't
// push the real ones out. In memory: a backend restart clears it.
const MAX_RUNS = 10;
let nextRunId = 1;

// What the admin panel polls. `phase` is "idle", "scanning" (listing the
// folder) or "importing" (downloading + enqueueing).
const state = {
  phase: "idle",
  lastError: null,
  lastScan: null,
  lastNoChangeAt: null,
  // Each: { id, trigger: "auto" | "manual", started_at, finished_at, found,
  // total, processed, queued, duplicates, failed, current, error, files }.
  // `files`, in import order: { name, folder, type, status, document_id,
  // message }, `status` being "waiting" | "downloading" | "queued" |
  // "duplicate" | "failed".
  runs: [],
};

/** `resourceKeys`: [[fileId, resourceKey], ...] for the items this request touches. */
const driveFetch = async (url, resourceKeys = []) => {
  const pairs = resourceKeys.filter(([, key]) => key).map(([id, key]) => `${id}/${key}`);
  const headers = pairs.length ? { "X-Goog-Drive-Resource-Keys": pairs.join(",") } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const reason = data.error?.message || response.statusText;
    throw Object.assign(new Error(`Google Drive request failed (${response.status}): ${reason}`), {
      status: response.status === 404 ? 404 : 502,
    });
  }
  return response;
};

// Some Drive files have no extension in their name ("Install Guide"); their
// Drive mime type still says what they are, and the name gets the extension
// the pipeline picks its parser from.
const EXTENSION_BY_MIME = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" };
EXTENSION_BY_MIME[GOOGLE_DOCX_MIME] = ".docx";

/** The name the document gets: the Drive name, with an extension added when it has none the pipeline knows. */
const fileNameOf = (f) => {
  if (GOOGLE_EXPORTS[f.mimeType]) return f.name.toLowerCase().endsWith(".pdf") ? f.name : `${f.name}.pdf`;
  if (kindOfFileName(f.name)) return f.name;
  return EXTENSION_BY_MIME[f.mimeType] ? `${f.name}${EXTENSION_BY_MIME[f.mimeType]}` : f.name;
};

/** The admin-facing type of a Drive item, and whether the sync takes it. */
const classify = (f) => {
  const exportType = GOOGLE_EXPORTS[f.mimeType];
  if (exportType) return { type: exportType, supported: true };
  const kind = kindOfFileName(fileNameOf(f));
  if (kind === "pdf") return { type: "PDF", supported: true };
  if (kind === "docx") return { type: "Word", supported: true };
  if (kind && isImageKind(kind)) return { type: "Image", supported: true };

  const name = f.name.toLowerCase();
  if (name.endsWith(".doc")) return { type: "Old Word (.doc)", supported: false };
  if (/\.(xlsx|xls|xlsm|csv)$/.test(name)) return { type: "Excel file", supported: false };
  if (f.mimeType === "application/vnd.google-apps.presentation" || /\.(pptx|ppt)$/.test(name)) {
    return { type: "Slides", supported: false };
  }
  if (f.mimeType === "application/vnd.google-apps.shortcut") return { type: "Shortcut", supported: false };
  if (f.mimeType.startsWith("video/")) return { type: "Video", supported: false };
  if (f.mimeType.startsWith("image/")) return { type: "Other image", supported: false };
  return { type: "Other", supported: false };
};

/**
 * Every item under the folder, subfolders included, in a stable order: a
 * folder's own files by name, then each subfolder (by name) in turn. Supported
 * ones come back ready to sync: `fileName` is the title the document gets
 * (".pdf" appended to an exported Google file), `exportPdf` says how to fetch it.
 */
const listFiles = async (folderId, resourceKey, acc = { files: [], skipped: {} }, folderPath = "") => {
  const subfolders = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, resourceKey)",
      orderBy: "name",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      key: API_KEY,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await driveFetch(`${API_BASE}/files?${params}`, [[folderId, resourceKey]])).json();

    for (const f of data.files ?? []) {
      if (f.mimeType === FOLDER_MIME) {
        subfolders.push(f);
        continue;
      }
      const { type, supported } = classify(f);
      if (!supported) {
        acc.skipped[type] = (acc.skipped[type] ?? 0) + 1;
        continue;
      }
      acc.files.push({
        id: f.id,
        resourceKey: f.resourceKey,
        modifiedTime: f.modifiedTime,
        type,
        exportPdf: Boolean(GOOGLE_EXPORTS[f.mimeType]),
        fileName: fileNameOf(f),
        folder: folderPath,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  for (const folder of subfolders) {
    await listFiles(folder.id, folder.resourceKey, acc, folderPath ? `${folderPath} / ${folder.name}` : folder.name);
  }
  return acc;
};

/** Lists the whole folder and records the counts the admin panel shows. */
const scan = async () => {
  const { files, skipped } = await listFiles(FOLDER_ID, FOLDER_RESOURCE_KEY);
  const titles = await listUploadTitles();
  const byType = {};
  let remaining = 0;
  for (const f of files) {
    const counts = (byType[f.type] ??= { total: 0, remaining: 0 });
    counts.total++;
    // By file name, so approximate: two different files with the same name count as one.
    if (!titles.has(f.fileName)) {
      counts.remaining++;
      remaining++;
    }
  }
  state.lastScan = {
    at: new Date().toISOString(),
    supported: files.length,
    inKnowledgeBase: files.length - remaining,
    remaining,
    byType,
    skipped,
  };
  return files;
};

const downloadAndEnqueue = async (file) => {
  const kind = kindOfFileName(file.fileName);
  const filePath = path.join(TEMP_UPLOAD_DIR, `${crypto.randomUUID()}${extensionOfKind(kind)}`);
  const url = file.exportPdf
    ? `${API_BASE}/files/${file.id}/export?${new URLSearchParams({ mimeType: "application/pdf", key: API_KEY })}`
    : `${API_BASE}/files/${file.id}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true", key: API_KEY })}`;
  const response = await driveFetch(url, [[file.id, file.resourceKey]]);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
  return enqueueIngestion({ filePath, fileName: file.fileName });
};

const ingestFiles = async (run, files) => {
  // One at a time, like the admin panel's uploads: the worker queues the heavy work anyway.
  for (const [index, file] of files.entries()) {
    const entry = run.files[index];
    run.current = file.fileName;
    entry.status = "downloading";
    try {
      const result = await downloadAndEnqueue(file);
      seen.set(file.id, file.modifiedTime);
      entry.status = result.duplicate ? "duplicate" : "queued";
      entry.document_id = result.documentId;
      if (result.duplicate) run.duplicates++;
      else run.queued++;
      logger.info(`[drive-sync] "${file.fileName}" -> ${result.duplicate ? "duplicate" : `queued as ${result.documentId}`}`);
    } catch (err) {
      // Left out of `seen`, so the next sync tries it again.
      run.failed++;
      entry.status = "failed";
      entry.message = err.message;
      logger.error(`[drive-sync] "${file.fileName}" failed`, err);
    }
    run.processed++;
  }
  run.current = null;
};

/**
 * Starts `work` unless a scan or sync is already running. Returns right away;
 * the admin panel follows progress through getDriveSyncStatus().
 */
const begin = (phase, work) => {
  if (!isDriveSyncConfigured()) {
    throw Object.assign(new Error("Google Drive sync is not configured (GOOGLE_API_KEY / GDRIVE_FOLDER_ID)"), { status: 503 });
  }
  if (state.phase !== "idle") {
    throw Object.assign(new Error("A Drive scan or sync is already running"), { status: 409 });
  }
  state.phase = phase;
  state.lastError = null;

  work()
    .catch((err) => {
      state.lastError = err.message;
      logger.error(`[drive-sync] ${phase} failed`, err);
    })
    .finally(() => {
      state.phase = "idle";
    });
};

/** Counts what the folder holds and how much is not imported yet. Downloads nothing. */
export const scanDriveFolder = () =>
  begin("scanning", async () => {
    await scan();
    logger.info(`[drive-sync] scan: ${state.lastScan.supported} supported file(s), ${state.lastScan.remaining} not imported`);
  });

/**
 * Lists the folder, then downloads and enqueues the new or changed files (up
 * to GDRIVE_SYNC_LIMIT), one at a time. `trigger` ("auto" | "manual") is shown
 * in the admin panel's sync history.
 */
export const syncDriveFolder = ({ trigger = "manual" } = {}) =>
  begin("scanning", async () => {
    const files = (await scan()).slice(0, SYNC_LIMIT);
    const pending = files.filter((f) => seen.get(f.id) !== f.modifiedTime);
    if (pending.length === 0) {
      state.lastNoChangeAt = new Date().toISOString();
      logger.info(`[drive-sync] ${trigger} sync: no new or changed files`);
      return;
    }
    logger.info(`[drive-sync] ${trigger} sync: importing ${pending.length} new or changed file(s) of ${files.length}`);

    const run = {
      id: nextRunId++,
      trigger,
      started_at: new Date().toISOString(),
      finished_at: null,
      found: files.length,
      total: pending.length,
      processed: 0,
      queued: 0,
      duplicates: 0,
      failed: 0,
      current: null,
      error: null,
      files: pending.map((f) => ({
        name: f.fileName,
        folder: f.folder,
        type: f.type,
        status: "waiting",
        document_id: null,
        message: null,
      })),
    };
    state.runs = [run, ...state.runs].slice(0, MAX_RUNS);
    state.phase = "importing";
    try {
      await ingestFiles(run, pending);
      await scan(); // refresh the "not imported yet" counts
    } catch (err) {
      run.error = err.message;
      throw err;
    } finally {
      run.finished_at = new Date().toISOString();
    }
  });

export const getDriveSyncStatus = () => ({
  configured: isDriveSyncConfigured(),
  auto_sync: AUTO_SYNC,
  interval_minutes: Math.round(INTERVAL_MS / 60000),
  limit: Number.isFinite(SYNC_LIMIT) ? SYNC_LIMIT : null,
  phase: state.phase,
  last_error: state.lastError,
  last_no_change_at: state.lastNoChangeAt,
  runs: state.runs,
  last_scan: state.lastScan && {
    at: state.lastScan.at,
    supported: state.lastScan.supported,
    in_knowledge_base: state.lastScan.inKnowledgeBase,
    remaining: state.lastScan.remaining,
    by_type: state.lastScan.byType,
    skipped: state.lastScan.skipped,
  },
});

/** With GDRIVE_AUTO_SYNC=true, syncs now and every GDRIVE_SYNC_INTERVAL_MS. Otherwise does nothing. */
export const startDriveSyncTimer = () => {
  if (!isDriveSyncConfigured() || !AUTO_SYNC) {
    logger.info("[drive-sync] automatic sync off (sync from the admin panel, or set GDRIVE_AUTO_SYNC=true)");
    return;
  }
  const tick = () => {
    try {
      syncDriveFolder({ trigger: "auto" });
    } catch (err) {
      if (err.status !== 409) logger.error("[drive-sync] scheduled sync failed", err);
    }
  };
  tick();
  setInterval(tick, INTERVAL_MS);
  logger.info(`[drive-sync] automatic sync every ${Math.round(INTERVAL_MS / 1000)}s`);
};
