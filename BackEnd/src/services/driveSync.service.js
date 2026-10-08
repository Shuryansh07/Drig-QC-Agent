import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TEMP_UPLOAD_DIR } from "../middleware/upload.middleware.js";
import { enqueueIngestion, discardDocument } from "./ragIngestion.service.js";
import { kindOfFileName, extensionOfKind, isImageKind } from "./chunking/documentTypes.js";
import { listUploadTitles } from "../db/documents.js";
import { cancelJobsBySource, countActiveJobsBySource } from "../db/jobs.js";
import * as ledger from "../db/driveSync.js";
import { logger } from "../utils/logger.js";

// Pulls documents from a Google Drive folder shared as "Anyone with the link"
// and feeds them through the same enqueueIngestion() the upload route uses.
// A link-shared folder is public, so an API key is all the Drive API needs —
// no service account, no access to the owner's account.
//
// The sync runs here, in the backend, not in the browser: reloading or closing
// the admin page does not touch it, and the page just reads the progress back.
// Every file's outcome is written to Postgres (drive_sync_file / drive_sync_run),
// so Stop, a crash or a restart never loses its place: the next Sync skips what
// is already imported and carries on with what was waiting, failed or cancelled.
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
// Minimum gap between two Google API requests (listing and downloads alike),
// so a big folder does not trip Google's rate limit (HTTP 429).
const REQUEST_DELAY_MS = parseInt(process.env.GDRIVE_REQUEST_DELAY_MS || "1000", 10);
// Folder listings are cheap for Google and there are many of them, so they wait less.
const LIST_DELAY_MS = parseInt(process.env.GDRIVE_LIST_DELAY_MS || "200", 10);
// When Google still answers 429 / rate-limit 403 / 5xx: wait (Retry-After, else
// 2s, 4s, 8s... up to 60s) and try again this many times before giving up on the file.
const MAX_RETRIES = parseInt(process.env.GDRIVE_MAX_RETRIES || "6", 10);

// Tags the worker jobs this sync creates, so Stop can find and cancel them.
const JOB_SOURCE = "drive-sync";
const MAX_RUNS = 10;

// Google-native files have no bytes of their own; Drive exports them. PDF is
// the export to use: Drive renders identical bytes for an unchanged file, so
// the sha256 dedup in enqueueIngestion() still recognizes it on a later sync
// (DOCX/XLSX exports differ byte-for-byte every time).
const GOOGLE_EXPORTS = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
};

export const isDriveSyncConfigured = () => Boolean(API_KEY && FOLDER_ID);

// What the admin panel polls, besides the history in Postgres. `phase` is
// "idle", "scanning" (listing the folder) or "importing" (downloading + enqueueing).
const state = {
  phase: "idle",
  lastError: null,
  lastScan: null,
  lastNoChangeAt: null,
  // The supported files of the last listing, kept to refresh lastScan after a sync without listing again.
  lastFiles: null,
  stopRequested: false,
  // The running scan/sync, so Stop can wait for it to wind down.
  work: null,
};

/** Thrown inside a running scan/sync once Stop was pressed. */
class StopError extends Error {
  constructor() {
    super("Stopped");
  }
}

/** Waits `ms`, but ends early (and throws) if Stop is pressed meanwhile. */
const sleep = async (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (state.stopRequested) throw new StopError();
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
  }
  if (state.stopRequested) throw new StopError();
};

let lastRequestAt = 0;
/** Keeps `delay` ms between Google requests. */
const pace = async (delay) => {
  const wait = lastRequestAt + delay - Date.now();
  lastRequestAt = Math.max(Date.now(), lastRequestAt + delay);
  if (wait > 0) await sleep(wait);
  else if (state.stopRequested) throw new StopError();
};

const isRateLimited = (status, data) =>
  status === 429 ||
  (status === 403 && /rate|quota/i.test(`${data.error?.message ?? ""} ${JSON.stringify(data.error?.errors ?? [])}`));

/** `resourceKeys`: [[fileId, resourceKey], ...] for the items this request touches. */
const driveFetch = async (url, resourceKeys = [], delay = REQUEST_DELAY_MS) => {
  const pairs = resourceKeys.filter(([, key]) => key).map(([id, key]) => `${id}/${key}`);
  const headers = pairs.length ? { "X-Goog-Drive-Resource-Keys": pairs.join(",") } : {};

  for (let attempt = 0; ; attempt++) {
    await pace(delay);
    const response = await fetch(url, { headers });
    if (response.ok) return response;

    const data = await response.json().catch(() => ({}));
    const reason = data.error?.message || response.statusText;
    if ((isRateLimited(response.status, data) || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after")) * 1000;
      const wait = retryAfter > 0 ? retryAfter : Math.min(60000, 2000 * 2 ** attempt);
      logger.warn(`[drive-sync] Google answered ${response.status}; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
      continue;
    }
    throw Object.assign(new Error(`Google Drive request failed (${response.status}): ${reason}`), {
      status: response.status === 404 ? 404 : 502,
    });
  }
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
    const data = await (await driveFetch(`${API_BASE}/files?${params}`, [[folderId, resourceKey]], LIST_DELAY_MS)).json();

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

/** Counts the listed files and how many are not in the knowledge base yet, for the admin panel. */
const summarize = async (files, skipped) => {
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
  state.lastFiles = { files, skipped };
};

/** Lists the whole folder and records the counts the admin panel shows. */
const scan = async () => {
  const { files, skipped } = await listFiles(FOLDER_ID, FOLDER_RESOURCE_KEY);
  await summarize(files, skipped);
  return files;
};

const downloadAndEnqueue = async (file) => {
  const kind = kindOfFileName(file.fileName);
  const filePath = path.join(TEMP_UPLOAD_DIR, `${crypto.randomUUID()}${extensionOfKind(kind)}`);
  const url = file.exportPdf
    ? `${API_BASE}/files/${file.id}/export?${new URLSearchParams({ mimeType: "application/pdf", key: API_KEY })}`
    : `${API_BASE}/files/${file.id}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true", key: API_KEY })}`;
  try {
    const response = await driveFetch(url, [[file.id, file.resourceKey]]);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
  } catch (err) {
    await fs.promises.rm(filePath, { force: true });
    throw err;
  }
  return enqueueIngestion({ filePath, fileName: file.fileName, source: JOB_SOURCE });
};

const ingestFiles = async (run, files) => {
  // One at a time, like the admin panel's uploads: the worker queues the heavy work anyway.
  for (const file of files) {
    if (state.stopRequested) break;
    await ledger.updateRun(run.id, { currentFile: file.fileName });
    await ledger.setFileState(file.id, { status: "downloading" });
    try {
      const result = await downloadAndEnqueue(file);
      await ledger.setFileState(file.id, { status: result.duplicate ? "duplicate" : "queued", docId: result.documentId });
      if (result.duplicate) run.duplicates++;
      else run.queued++;
      logger.info(`[drive-sync] "${file.fileName}" -> ${result.duplicate ? "duplicate" : `queued as ${result.documentId}`}`);
    } catch (err) {
      if (err instanceof StopError) {
        // Not done, not failed: it waits for the next Sync.
        await ledger.setFileState(file.id, { status: "waiting" });
        break;
      }
      run.failed++;
      await ledger.setFileState(file.id, { status: "failed", message: err.message });
      logger.error(`[drive-sync] "${file.fileName}" failed`, err);
    }
    run.processed++;
    await ledger.updateRun(run.id, run);
  }
  run.stopped = state.stopRequested;
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
  state.stopRequested = false;

  state.work = work()
    .catch((err) => {
      if (err instanceof StopError) {
        logger.info(`[drive-sync] ${phase} stopped`);
        return;
      }
      state.lastError = err.message;
      logger.error(`[drive-sync] ${phase} failed`, err);
    })
    .finally(() => {
      state.phase = "idle";
      state.work = null;
    });
};

/** Counts what the folder holds and how much is not imported yet. Downloads nothing. */
export const scanDriveFolder = () =>
  begin("scanning", async () => {
    await scan();
    logger.info(`[drive-sync] scan: ${state.lastScan.supported} supported file(s), ${state.lastScan.remaining} not imported`);
  });

/**
 * Lists the folder, then downloads and enqueues what the ledger says is still
 * to do (new or changed files, plus ones left waiting, failed or cancelled by
 * an earlier run), one at a time, up to GDRIVE_SYNC_LIMIT files of the folder.
 * `trigger` ("auto" | "manual") is shown in the admin panel's sync history.
 */
export const syncDriveFolder = ({ trigger = "manual" } = {}) =>
  begin("scanning", async () => {
    const files = (await scan()).slice(0, SYNC_LIMIT);
    const known = new Map((await ledger.listLedger()).map((row) => [row.file_id, row]));
    const pending = files.filter((f) => {
      const row = known.get(f.id);
      return !row || row.modified_time !== f.modifiedTime || !["queued", "duplicate"].includes(row.status);
    });
    if (pending.length === 0) {
      state.lastNoChangeAt = new Date().toISOString();
      logger.info(`[drive-sync] ${trigger} sync: no new or changed files`);
      return;
    }
    const resumed = pending.filter((f) => known.has(f.id) && known.get(f.id).modified_time === f.modifiedTime).length;
    logger.info(`[drive-sync] ${trigger} sync: importing ${pending.length} file(s) of ${files.length} (${resumed} resumed from an earlier run)`);

    const run = { id: await ledger.createRun(trigger, files.length, pending.length), processed: 0, queued: 0, duplicates: 0, failed: 0, stopped: false };
    await ledger.assignFilesToRun(
      run.id,
      pending.map((f) => ({ id: f.id, name: f.fileName, folder: f.folder, type: f.type, modifiedTime: f.modifiedTime }))
    );
    state.phase = "importing";
    try {
      await ingestFiles(run, pending);
      if (!run.stopped) await summarize(state.lastFiles.files, state.lastFiles.skipped); // refresh the "not imported yet" counts
    } catch (err) {
      await ledger.updateRun(run.id, { error: err.message });
      throw err;
    } finally {
      await ledger.updateRun(run.id, { ...run, currentFile: null, finished: true });
    }
  });

/**
 * Stops the scan or sync: the file in flight is dropped, nothing more is
 * downloaded, and the worker jobs the sync already queued are cancelled (a job
 * not yet claimed is never taken; one already running stops at its next
 * checkpoint). Their files go back to "waiting" in the ledger, so the next Sync
 * picks up exactly there.
 */
export const stopDriveSync = async () => {
  const active = await countActiveJobsBySource(JOB_SOURCE);
  if (state.phase === "idle" && active === 0) {
    throw Object.assign(new Error("No Drive sync is running"), { status: 409 });
  }
  state.stopRequested = true;
  // Let the loop wind down first, or the file it is on could queue a job after the cancel below.
  await state.work;

  const cancelled = await cancelJobsBySource(JOB_SOURCE);
  const docIds = cancelled.map((job) => job.docId).filter(Boolean);
  await ledger.requeueFilesOfDocs(docIds);
  // A running job's worker discards its own document; the rest never started, so drop theirs here
  // (otherwise a later sync would take the leftover document for a duplicate and never process it).
  await Promise.all(cancelled.filter((job) => job.docId && !job.wasRunning).map((job) => discardDocument(job.docId)));
  logger.info(`[drive-sync] stopped: ${cancelled.length} job(s) cancelled, ${docIds.length} file(s) waiting for the next sync`);
};

export const getDriveSyncStatus = async () => ({
  configured: isDriveSyncConfigured(),
  auto_sync: AUTO_SYNC,
  interval_minutes: Math.round(INTERVAL_MS / 60000),
  limit: Number.isFinite(SYNC_LIMIT) ? SYNC_LIMIT : null,
  phase: state.phase,
  stopping: state.stopRequested && state.phase !== "idle",
  pending_jobs: await countActiveJobsBySource(JOB_SOURCE),
  /** Files a stopped, failed or interrupted sync left to do: the next Sync resumes with them. */
  resumable: await ledger.countResumable(),
  last_error: state.lastError,
  last_no_change_at: state.lastNoChangeAt,
  runs: await ledger.listRuns(MAX_RUNS),
  last_scan: state.lastScan && {
    at: state.lastScan.at,
    supported: state.lastScan.supported,
    in_knowledge_base: state.lastScan.inKnowledgeBase,
    remaining: state.lastScan.remaining,
    by_type: state.lastScan.byType,
    skipped: state.lastScan.skipped,
  },
});

/**
 * At startup: settles a sync a restart interrupted (its files wait for the next
 * Sync). With GDRIVE_AUTO_SYNC=true, also syncs now and every GDRIVE_SYNC_INTERVAL_MS.
 */
export const startDriveSyncTimer = () => {
  ledger.recoverInterruptedRuns().catch((err) => logger.error("[drive-sync] could not settle an interrupted sync", err));
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
