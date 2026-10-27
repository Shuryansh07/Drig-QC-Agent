import ExcelJS from "exceljs";
import { signPhotoUrl, getThumbBuffer } from "./wiresheetPhotos.service.js";

// Builds the "Vehicles" tracker workbook from the DB records (see
// db/wiresheet.ts). This mirrors the layout the scraper's writeReport() produced
// (WireSheetScraper/scrape.mjs): one sheet, a block of rows per vehicle (one per
// 12V / ignition option), coloured status cells, and each option's photo shown
// as an embedded thumbnail that links to the full-size image in S3.

const IS_12V_WIRE = /^constant\s*\+?\s*12\s*v(olts?)?(\s*\(\d+\))?$/i;
const IS_IGNITION_WIRE = /^ignition(\s*\(\d+\))?$/i;
const THUMB_WIDTH = 170;

const THIN = { style: "thin", color: { argb: "FF999999" } };
const MEDIUM = { style: "medium", color: { argb: "FF1F4E78" } };
const FILL = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

/** The same circuit is often listed under several sections (Remote Start, Security): show each option once. */
const uniqueOptions = (wires) => {
  const seen = new Set();
  return wires.filter((w) => {
    const key = [w.function, w.color, w.polarity, w.location, w.imageContentHash ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** "Constant +12 Volts: Red (+) BCM-Dash Fuse Box, pin 22 (30A)". */
const describeOption = (w) =>
  `${w.function}: ${[w.color, w.polarity, w.location].filter((p) => p && p.toLowerCase() !== "null").join(" ")}${w.notes ? ` (${w.notes})` : ""}`;

/** Run async `fn` over `items` with a bounded number in flight. */
const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
};

// Excel can't reliably render more than ~1000 embedded images in one sheet (it
// shows "image cannot currently be displayed" for the overflow). Past that, each
// photo becomes a clickable link instead of an embedded thumbnail — so a full
// export (thousands of photos) stays usable, while a per-make one keeps thumbnails.
const EMBED_CAP = 1000;

const countPhotoPlacements = (records) => {
  const has = (o) => Boolean(o && o.imageS3Key);
  return records.reduce(
    (n, v) =>
      n +
      uniqueOptions((v.wires ?? []).filter((w) => IS_12V_WIRE.test(w.function))).filter(has).length +
      uniqueOptions((v.wires ?? []).filter((w) => IS_IGNITION_WIRE.test(w.function))).filter(has).length,
    0
  );
};

/**
 * Pre-fetches every distinct thumbnail (only when we will embed) and signs every
 * distinct full-photo URL in parallel, up front — so the row-building loop reads
 * them from maps instead of making thousands of sequential S3 round-trips.
 */
const prefetchPhotos = async (records, embedThumbs) => {
  const thumbKeys = new Set();
  const s3Keys = new Set();
  for (const v of records) {
    for (const w of v.wires ?? []) {
      if (embedThumbs && w.imageThumbKey) thumbKeys.add(w.imageThumbKey);
      if (w.imageS3Key) s3Keys.add(w.imageS3Key);
    }
  }

  const thumbs = new Map(); // thumbKey -> Buffer | null
  const urls = new Map(); // s3Key -> signed url | null
  await Promise.all([
    mapWithConcurrency([...thumbKeys], 12, async (k) => thumbs.set(k, await getThumbBuffer(k))),
    mapWithConcurrency([...s3Keys], 12, async (k) => urls.set(k, await signPhotoUrl(k))),
  ]);
  return { thumbs, urls };
};

export const buildTrackerWorkbook = async (records) => {
  const embedThumbs = countPhotoPlacements(records) <= EMBED_CAP;
  const { thumbs, urls } = await prefetchPhotos(records, embedThumbs);

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Vehicles");
  const headers = ["Make", "Year", "Model", "Key type", "12V", "Ignition", "12V option", "12V photo", "Ignition option", "Ignition photo"];
  sheet.columns = headers.map((header) => ({ header }));
  const imageIds = new Map(); // content hash -> workbook image id (embed each distinct thumbnail once)

  for (const v of records) {
    const wires = v.wires ?? [];
    const errored = v.status === "error";
    const read = v.status === "ok";
    const twelve = uniqueOptions(wires.filter((w) => IS_12V_WIRE.test(w.function)));
    const ignition = uniqueOptions(wires.filter((w) => IS_IGNITION_WIRE.test(w.function)));
    const hasPhoto = (w) => Boolean(w.imageS3Key);
    const labelFor = (option, i) =>
      errored ? "Error" : !read ? "Not found on site" : option ? (hasPhoto(option) ? "Found" : "Not found on site") : i === 0 ? "Not found on site" : "";

    const rows = Math.max(1, twelve.length, ignition.length);
    for (let i = 0; i < rows; i++) {
      const options = [twelve[i], ignition[i]];
      const row = sheet.addRow([
        v.make, Number(v.year) || v.year, v.model, v.keyType ?? "", labelFor(twelve[i], i), labelFor(ignition[i], i),
        twelve[i] ? describeOption(twelve[i]) : "", "", ignition[i] ? describeOption(ignition[i]) : "", "",
      ]);

      for (let col = 1; col <= 3; col++) row.getCell(col).fill = FILL(["FFFFF2CC", "FFF4CCCC", "FFD9EAD3"][col - 1]);
      for (const col of [5, 6]) {
        const value = row.getCell(col).value;
        row.getCell(col).fill = FILL(value === "Found" ? "FFC6EFCE" : value === "" ? "FFF2F2F2" : "FFFFC7CE");
      }
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = { top: i === 0 ? MEDIUM : THIN, left: THIN, bottom: THIN, right: THIN };
        const textColumn = col === 7 || col === 9;
        cell.alignment = { vertical: "middle", horizontal: textColumn ? "left" : "center", wrapText: textColumn };
        if (col <= 4) cell.font = { bold: true };
      });

      // The photo of each option: an embedded thumbnail that opens the full-size image (signed link, expires).
      let tallest = 0;
      for (const [slot, option] of options.entries()) {
        if (!option || !option.imageS3Key) continue;
        const col = slot === 0 ? 8 : 10;
        const link = urls.get(option.imageS3Key) ?? null;
        const buffer = option.imageThumbKey ? thumbs.get(option.imageThumbKey) : null;
        if (!buffer) {
          row.getCell(col).value = link ? { text: "Open photo", hyperlink: link } : "photo in S3";
          if (link) row.getCell(col).font = { color: { argb: "FF0563C1" }, underline: true };
          continue;
        }
        const width = option.imageWidth ?? THUMB_WIDTH;
        const height = option.imageHeight ?? THUMB_WIDTH;
        if (!imageIds.has(option.imageContentHash)) imageIds.set(option.imageContentHash, wb.addImage({ buffer, extension: "jpeg" }));
        sheet.addImage(imageIds.get(option.imageContentHash), {
          tl: { col: col - 1 + 0.04, row: row.number - 1 + 0.04 },
          ext: { width, height },
          editAs: "oneCell",
          ...(link && { hyperlinks: { hyperlink: link, tooltip: "Open the full-size photo (link expires)" } }),
        });
        tallest = Math.max(tallest, height);
      }
      if (tallest > 0) row.height = Math.round(tallest * 0.75) + 8;
      else if (row.getCell(7).value || row.getCell(9).value) row.height = 32;

      // "Found" opens this row's own photo.
      for (const [col, option] of [[5, twelve[i]], [6, ignition[i]]]) {
        const link = option?.imageS3Key ? urls.get(option.imageS3Key) : null;
        if (link && row.getCell(col).value === "Found") {
          row.getCell(col).value = { text: "Found", hyperlink: link };
          row.getCell(col).font = { color: { argb: "FF0563C1" }, underline: true, bold: true };
        }
      }
    }
  }

  sheet.columns = [16, 8, 24, 20, 18, 18, 46, 26, 46, 26].map((width, i) => ({ ...sheet.columns[i], width }));
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = FILL("FFFFFF00");
    cell.font = { bold: true, color: { argb: "FF000000" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  return wb;
};
