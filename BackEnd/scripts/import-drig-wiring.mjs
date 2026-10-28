// Imports DRIG's vehicle wiring guide straight from an .xlsx on disk, without
// the admin panel or the worker: stores the workbook in the DRIG wiring bucket,
// creates the import, then runs the same import the worker would (parse ->
// follow every link and copy the photo/guide into the bucket -> publish -> OCR).
//
//   npm run wiring:import -- "../DrigDocuments/Vehicle wiring guide April 2026 (1).xlsx"
//   npm run wiring:import -- <file> --force     re-import even if this exact workbook is already live
//
// Safe to re-run: links already stored and photos already read are not done again.
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as wiring from "../src/db/drigWiring.js";
import { pool } from "../src/db/pool.js";
import { putObject } from "../src/services/wiring/wiringBuckets.js";
import { runDrigWiringImport, parseWiringWorkbook } from "../src/services/wiring/drigWiringImport.service.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error('Usage: npm run wiring:import -- "<path to wiring guide .xlsx>" [--force]');
  process.exit(1);
}

try {
  const buffer = await fs.readFile(file);
  // Fails fast, before anything is stored, if this is not the wiring guide.
  const { counts } = await parseWiringWorkbook(buffer);
  console.log(`Workbook OK: ${counts.vehicles} vehicle rows, ${counts.cells_link} linked cells, ${counts.cells_text} written values.`);

  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const existing = await wiring.findActiveImportByHash(contentHash);
  let importId;
  if (existing && !force) {
    if (existing.isLive && existing.status !== "failed") {
      console.log(`This exact workbook is already the live guide (import ${existing.importId}, ${existing.status}). Use --force to import it again.`);
      process.exit(0);
    }
    importId = existing.importId; // queued/processing from an interrupted run: resume it
    console.log(`Resuming import ${importId}.`);
  } else {
    const fileName = path.basename(file).replace(/[^\w.() -]+/g, "_").slice(0, 120);
    const s3Key = `imports/${contentHash}/${fileName}`;
    await putObject("drig_wiring", s3Key, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    importId = (await wiring.createImport({ fileName, contentHash, s3Key })).importId;
    console.log(`Workbook stored as ${s3Key}; import ${importId} created.`);
  }

  // Progress from the import's own counters while it runs.
  const ticker = setInterval(async () => {
    const row = await wiring.getImport(importId).catch(() => null);
    if (!row) return;
    const c = row.counts;
    const detail =
      row.stage === "fetching links" ? `links ${c.links_done ?? 0}/${c.links_total ?? "?"}` : row.stage === "reading photos" ? `photos ${(c.ocr_done ?? 0) + (c.ocr_no_text ?? 0) + (c.ocr_failed ?? 0)}/${c.ocr_total ?? "?"}` : "";
    console.log(`  [${new Date().toLocaleTimeString()}] ${row.stage ?? row.status} ${detail}`);
  }, 15_000);

  const result = await runDrigWiringImport({ importId });
  clearInterval(ticker);
  console.log("\nDone:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`\nImport failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
