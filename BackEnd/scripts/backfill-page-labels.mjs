// Fills kb_document_page.page_label (migration 0830) for PDFs ingested before
// printed page numbers were read. New ingestions set it themselves.
//
// Ingestion deletes its copy of a file once the document is complete, and the
// WorkDrive token cannot download, so the bytes come back from the Google Drive
// folder they were synced from (drive_sync_file). The folder is listed once
// first: old "0B…" files can only be downloaded with the resource key that
// listing returns. A file whose bytes no longer match the ingested content_hash
// changed in Drive since: its pages may not line up with the stored ones, so it
// is skipped, not guessed at.
//
//   node --import tsx scripts/backfill-page-labels.mjs [--dry-run] [--limit N] [--title "AD Plus2.0"]
//
// Safe to rerun: a page whose label is already right is not written again.
import "dotenv/config";
import crypto from "node:crypto";
import { pool } from "../src/db/pool.js";
import { extractDocumentBlocks } from "../src/services/chunking/pdfStructure.js";
import { setPageLabels } from "../src/db/documentPages.js";
import { listSyncedFiles, downloadSyncedFile } from "../src/services/driveSync.service.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = flag("--dry-run");
const limit = parseInt(option("--limit") ?? "0", 10) || null;
const titleFilter = option("--title");

const { rows: docs } = await pool.query(
  `select distinct on (d.doc_id) d.doc_id, d.title, d.content_hash, f.file_id
     from kb_document d
     join drive_sync_file f on f.doc_id = d.doc_id
    where d.status = 'current' and d.live_version > 0 and d.title ~* '\\.pdf$'
      and ($1::text is null or d.title ilike '%' || $1 || '%')
    order by d.doc_id, f.updated_at desc`,
  [titleFilter ?? null]
);
const todo = limit ? docs.slice(0, limit) : docs;
console.log(`${todo.length} PDF(s) to read${dryRun ? " (dry run, nothing written)" : ""}. Listing the Drive folder…`);
const listedById = new Map((await listSyncedFiles()).map((f) => [f.id, f]));

const totals = { labelled: 0, unlabelled: 0, changed: 0, notInDrive: 0, failed: 0, pagesWritten: 0 };

for (const [i, doc] of todo.entries()) {
  const tag = `[${i + 1}/${todo.length}] ${doc.title}`;
  try {
    const listed = listedById.get(doc.file_id);
    if (!listed) {
      totals.notInDrive++;
      console.log(`${tag}: SKIPPED, no longer in the Drive folder`);
      continue;
    }
    const buffer = await downloadSyncedFile(listed);

    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (doc.content_hash && hash !== doc.content_hash) {
      totals.changed++;
      console.log(`${tag}: SKIPPED, the Drive file changed since it was ingested`);
      continue;
    }

    const { pages } = await extractDocumentBlocks(buffer);
    const labels = pages.map((p) => ({ pageNumber: p.pageNumber, pageLabel: p.pageLabel ?? null }));
    const found = labels.filter((l) => l.pageLabel !== null);
    if (found.length > 0) totals.labelled++;
    else totals.unlabelled++;

    const written = dryRun ? 0 : await setPageLabels(doc.doc_id, labels);
    totals.pagesWritten += written;
    const sample = found.slice(0, 6).map((l) => `${l.pageNumber}→${l.pageLabel}`).join(" ");
    console.log(`${tag}: ${found.length}/${pages.length} page(s) labelled${sample ? ` (${sample}${found.length > 6 ? " …" : ""})` : ""}${dryRun ? "" : `, ${written} written`}`);
  } catch (err) {
    totals.failed++;
    console.log(`${tag}: FAILED, ${err.message}`);
  }
}

console.log(`\nDone. ${JSON.stringify(totals)}`);
await pool.end();
