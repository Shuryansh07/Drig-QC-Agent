import crypto from "node:crypto";
import ExcelJS from "exceljs";
import * as wiring from "../../db/drigWiring.js";
import { touchJob } from "../../db/jobs.js";
import { classifyLink, fetchLinkedFile } from "./linkFetcher.js";
import { prepareImage, preparePdf, ocrWiringImage, ocrModelTag } from "./wiringAssets.js";
import { makeKeys, parseSheetModel, squash } from "./vehicleNames.js";
import { putObject, getObject } from "./wiringBuckets.js";
import { logger } from "../../utils/logger.js";

// Imports DRIG's "Vehicle wiring guide" workbook (Year | Make | Model |
// Install Guide 12v | Install Guide Ignition | Requires Login | Need to
// download then upload) into the drig_wiring_* tables, and copies every
// photo/guide its cells link to into the DRIG wiring bucket.
//
// Runs in the worker (job type import_drig_wiring), never in a request:
//   1. parse        the workbook -> one vehicle row per sheet row, verbatim cells
//   2. links        every distinct link, once: download, store, make a preview
//                   (a link already stored by an earlier import is not fetched again)
//   3. publish      swap this import in as the live guide
//   4. ocr          read each new photo once with the OCR model
// Each step is safe to run again, so a retried job resumes instead of redoing
// paid work. Links that need a login (Directechs) or are not files are
// recorded with the reason and never block the import.

const LINK_CONCURRENCY = parseInt(process.env.DRIG_WIRING_LINK_CONCURRENCY || "4", 10);
const OCR_CONCURRENCY = parseInt(process.env.DRIG_WIRING_OCR_CONCURRENCY || "3", 10);
const HEARTBEAT_MS = 60_000;
const CELL_TEXT_MAX = 1000;
const MIN_YEAR = 1950;
const MAX_YEAR = 2100;

export const DRIG_WIRING_JOB = "import_drig_wiring";

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const runWithConcurrency = async (items, limit, worker) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    })
  );
};

// ---------------------------------------------------------------------------
// 1. Parse
// ---------------------------------------------------------------------------

const HEADER_TESTS = {
  year: (h) => h === "year",
  make: (h) => h === "make",
  model: (h) => h === "model",
  v12: (h) => /12\s*v|12\s*volt/.test(h),
  ignition: (h) => /\bign/.test(h),
  requiresLogin: (h) => /requires?\s*login/.test(h),
  needsDownload: (h) => /download/.test(h),
};
const REQUIRED_COLUMNS = ["year", "make", "model", "v12", "ignition"];
const COLUMN_NAMES = { year: "Year", make: "Make", model: "Model", v12: "Install Guide 12v", ignition: "Install Guide Ignition" };

export class WorkbookFormatError extends Error {
  status = 400;
}

const cellText = (cell) => {
  const text = typeof cell?.text === "string" ? cell.text : cell?.value == null ? "" : String(cell.value);
  return text.replace(/\s+/g, " ").trim();
};

const looksLikeUrl = (text) => /^https?:\/\/\S+$/i.test(text);

/** A 12V / ignition cell -> what it holds. The text is kept verbatim either way. */
const classifyCell = (cell) => {
  const text = cellText(cell).slice(0, CELL_TEXT_MAX) || null;
  const hyperlink = typeof cell?.hyperlink === "string" && cell.hyperlink.trim() ? cell.hyperlink.trim() : null;
  const url = hyperlink ?? (text && looksLikeUrl(text) ? text : null);

  if (url) {
    // A pasted Wiresheet icon carries no wiring information at all.
    if (classifyLink(url).action === "icon") return { cellKind: "icon", cellText: text, linkUrl: url };
    return { cellKind: "link", cellText: text && text !== url ? text : null, linkUrl: url };
  }
  if (text) return { cellKind: "text", cellText: text, linkUrl: null };
  return { cellKind: "empty", cellText: null, linkUrl: null };
};

const isMarked = (cell) => {
  const text = cellText(cell).toLowerCase();
  return text !== "" && text !== "no" && text !== "n" && text !== "false" && text !== "0";
};

/**
 * Pure: workbook bytes -> vehicle rows + counts. Throws WorkbookFormatError
 * (shown to the admin as-is) when the sheet is not the wiring guide.
 */
export const parseWiringWorkbook = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    throw new WorkbookFormatError(`The file could not be read as an Excel workbook (${err.message}).`);
  }

  // The first sheet with the guide's headers in one of its first rows.
  let sheet = null;
  let headerRow = 0;
  let columns = null;
  for (const ws of workbook.worksheets) {
    for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
      const found = {};
      ws.getRow(r).eachCell((cell, col) => {
        const header = cellText(cell).toLowerCase();
        for (const [key, test] of Object.entries(HEADER_TESTS)) if (!found[key] && test(header)) found[key] = col;
      });
      if (REQUIRED_COLUMNS.every((k) => found[k])) {
        sheet = ws;
        headerRow = r;
        columns = found;
        break;
      }
    }
    if (sheet) break;
  }
  if (!sheet) {
    throw new WorkbookFormatError(
      `This does not look like the vehicle wiring guide: no sheet has the columns ${REQUIRED_COLUMNS.map((k) => `"${COLUMN_NAMES[k]}"`).join(", ")} in its first rows.`
    );
  }

  const vehicles = [];
  const counts = { sheet_rows: 0, vehicles: 0, placeholder_rows: 0, bad_year_rows: 0, cells_text: 0, cells_link: 0, cells_icon: 0, cells_empty: 0 };

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    counts.sheet_rows++;
    const make = cellText(row.getCell(columns.make));
    const modelRaw = cellText(row.getCell(columns.model));
    // Years dragged down with no make/model yet (the sheet's "not filled in" rows).
    if (!make || !modelRaw) {
      counts.placeholder_rows++;
      return;
    }
    const year = Math.round(Number(cellText(row.getCell(columns.year))));
    if (!Number.isFinite(year) || year < MIN_YEAR || year > MAX_YEAR) {
      counts.bad_year_rows++;
      return;
    }

    const { model, startType } = parseSheetModel(modelRaw);
    const entries = [
      { circuit: "12v", ...classifyCell(row.getCell(columns.v12)) },
      { circuit: "ignition", ...classifyCell(row.getCell(columns.ignition)) },
    ];
    for (const e of entries) counts[`cells_${e.cellKind}`]++;

    vehicles.push({
      sourceRow: rowNumber,
      year,
      makeRaw: make,
      makeKeys: makeKeys(make),
      modelRaw,
      model,
      modelKey: squash(model),
      startType,
      requiresLogin: columns.requiresLogin ? isMarked(row.getCell(columns.requiresLogin)) : false,
      needsDownload: columns.needsDownload ? isMarked(row.getCell(columns.needsDownload)) : false,
      entries,
    });
  });
  counts.vehicles = vehicles.length;
  if (vehicles.length === 0) throw new WorkbookFormatError("The workbook has the right columns but no vehicle rows (year, make and model).");

  return { vehicles, counts, sheetName: sheet.name };
};

// ---------------------------------------------------------------------------
// 2. Links -> stored files
// ---------------------------------------------------------------------------

/** Download -> previews -> S3 -> asset row. Returns the asset (existing or new). */
const storeFile = async (file) => {
  const contentHash = sha256(file.buffer);
  const existing = await wiring.findAssetByHash(contentHash);
  if (existing) return existing;

  const prepared = file.kind === "pdf" ? await preparePdf(file.buffer) : await prepareImage(file.buffer);
  const s3Key = file.kind === "pdf" ? `doc/${contentHash}.pdf` : `img/${contentHash}.${file.ext}`;
  const previewKey = prepared.preview ? `preview/${contentHash}.jpg` : file.kind === "image" ? s3Key : null;
  const thumbKey = prepared.thumb ? `thumb/${contentHash}.jpg` : null;

  await putObject("drig_wiring", s3Key, file.buffer, file.mime);
  if (prepared.preview) await putObject("drig_wiring", previewKey, prepared.preview, "image/jpeg");
  if (prepared.thumb) await putObject("drig_wiring", thumbKey, prepared.thumb, "image/jpeg");

  // A guide whose own text layer is readable needs no OCR of its first page.
  const ocrStatus = file.kind === "pdf" && prepared.hasUsableText ? "skipped" : "pending";
  return wiring.insertAsset({
    contentHash,
    kind: file.kind,
    mimeType: file.mime,
    s3Key,
    previewKey,
    thumbKey,
    width: prepared.width,
    height: prepared.height,
    bytes: file.buffer.length,
    pageCount: prepared.pageCount ?? null,
    textLayer: prepared.textLayer ?? null,
    ocrStatus,
  });
};

// Statuses that are final: the next import does not try the link again.
const SETTLED = new Set(["stored", "requires_login", "icon", "unsupported"]);

const processLinks = async (urls, { progress }) => {
  const cache = await wiring.loadLinks();
  const assetIds = new Set();
  let done = 0;

  await runWithConcurrency(urls, LINK_CONCURRENCY, async (url) => {
    const cached = cache.get(url);
    if (cached && SETTLED.has(cached.status)) {
      if (cached.assetId) assetIds.add(cached.assetId);
      progress(cached.status, ++done);
      return;
    }

    const plan = classifyLink(url);
    let record;
    if (plan.action !== "fetch") {
      record = { sourceUrl: url, linkKind: plan.kind, status: plan.action, assetId: null, error: plan.reason ?? null };
    } else {
      const result = await fetchLinkedFile(plan.fetchUrl);
      if (!result.ok) {
        record = { sourceUrl: url, linkKind: plan.kind, status: result.status, assetId: null, error: result.error };
      } else {
        try {
          const asset = await storeFile(result);
          record = { sourceUrl: url, linkKind: plan.kind, status: "stored", assetId: asset.assetId, error: null };
        } catch (err) {
          logger.error(`[drig wiring] could not store ${url}`, err);
          record = { sourceUrl: url, linkKind: plan.kind, status: "failed", assetId: null, error: `could not store the file: ${err.message}`.slice(0, 500) };
        }
      }
    }
    await wiring.saveLink(record);
    if (record.assetId) assetIds.add(record.assetId);
    progress(record.status, ++done);
  });

  return [...assetIds];
};

// ---------------------------------------------------------------------------
// 4. OCR
// ---------------------------------------------------------------------------

const labelsByAsset = async (vehicles, assetIds) => {
  // One sheet label per asset is enough context for the reading ("CSX 12V").
  const cache = await wiring.loadLinks();
  const labels = new Map();
  for (const v of vehicles) {
    for (const e of v.entries) {
      const assetId = e.linkUrl ? cache.get(e.linkUrl)?.assetId : null;
      if (assetId && assetIds.includes(assetId) && !labels.has(assetId) && e.cellText) labels.set(assetId, e.cellText);
    }
  }
  return labels;
};

const runOcr = async (vehicles, assetIds, { progress }) => {
  const todo = await wiring.listAssetsToOcr(assetIds);
  const labels = await labelsByAsset(vehicles, assetIds);
  const model = ocrModelTag();
  let done = 0;

  await runWithConcurrency(todo, OCR_CONCURRENCY, async (asset) => {
    try {
      const preview = await getObject("drig_wiring", asset.previewKey);
      const reading = await ocrWiringImage(preview, { label: labels.get(asset.assetId) });
      await wiring.saveOcr(asset.assetId, { status: reading.status, text: reading.text, json: reading.json, model });
      progress(reading.status, ++done, todo.length);
    } catch (err) {
      logger.warn(`[drig wiring] OCR failed for asset ${asset.assetId}: ${err.message}`);
      await wiring.saveOcr(asset.assetId, { status: "failed", model, error: String(err.message || err).slice(0, 500) });
      progress("failed", ++done, todo.length);
    }
  });
  return todo.length;
};

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/** Called by the worker for a job of type DRIG_WIRING_JOB. */
export const runDrigWiringImport = async ({ importId, jobId }) => {
  const job = await wiring.getImport(importId);
  if (!job) throw Object.assign(new Error(`Wiring import ${importId} not found`), { status: 404 });

  const heartbeat = jobId ? setInterval(() => touchJob(jobId).catch(() => {}), HEARTBEAT_MS) : null;
  const counts = { ...job.counts };
  let lastSaved = 0;
  const saveCounts = async (force = false) => {
    if (!force && Date.now() - lastSaved < 3000) return;
    lastSaved = Date.now();
    await wiring.updateImport(importId, { counts: { ...counts } }).catch(() => {});
  };

  try {
    await wiring.updateImport(importId, { status: "processing", stage: "parsing", error: null, started: true });
    const buffer = await getObject("drig_wiring", job.s3Key);
    const { vehicles, counts: parsed, sheetName } = await parseWiringWorkbook(buffer);
    Object.assign(counts, parsed);
    logger.info(`[drig wiring ${importId}] sheet "${sheetName}": ${vehicles.length} vehicle rows (${parsed.placeholder_rows} placeholder rows skipped)`);
    await wiring.replaceImportVehicles(importId, vehicles);

    const urls = [...new Set(vehicles.flatMap((v) => v.entries.filter((e) => e.cellKind === "link").map((e) => e.linkUrl)))];
    Object.assign(counts, { links_total: urls.length, links_done: 0, links_stored: 0, links_requires_login: 0, links_icon: 0, links_unsupported: 0, links_failed: 0 });
    await wiring.updateImport(importId, { stage: "fetching links", counts });

    const assetIds = await processLinks(urls, {
      progress: (status, done) => {
        counts[`links_${status}`] = (counts[`links_${status}`] ?? 0) + 1;
        counts.links_done = done;
        void saveCounts();
      },
    });
    counts.assets = assetIds.length;
    await saveCounts(true);

    // Live from here: text cells and photos are served now; readings fill in as OCR finishes.
    await wiring.updateImport(importId, { stage: "publishing" });
    await wiring.publishImport(importId);
    logger.info(`[drig wiring ${importId}] published (${counts.links_stored} stored, ${counts.links_requires_login} need a login, ${counts.links_failed} failed)`);

    Object.assign(counts, { ocr_total: 0, ocr_done: 0, ocr_no_text: 0, ocr_failed: 0 });
    await wiring.updateImport(importId, { stage: "reading photos", counts });
    counts.ocr_total = await runOcr(vehicles, assetIds, {
      progress: (status, done, total) => {
        counts.ocr_total = total;
        counts[`ocr_${status}`] = (counts[`ocr_${status}`] ?? 0) + 1;
        void saveCounts();
      },
    });

    const withErrors = (counts.links_failed ?? 0) > 0 || (counts.ocr_failed ?? 0) > 0;
    await wiring.updateImport(importId, { status: withErrors ? "completed_with_errors" : "completed", stage: null, counts, finished: true });
    logger.info(`[drig wiring ${importId}] done: ${JSON.stringify(counts)}`);
    return counts;
  } catch (err) {
    await wiring.updateImport(importId, { status: "failed", stage: null, counts, error: String(err.message || err).slice(0, 1000), finished: true }).catch(() => {});
    throw err;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
};
