// Offline chunking preview: parses a PDF or Word (.docx) file and prints the parent/child tree.
// No database, no OpenAI, no worker — use it to check how a manual is being
// split and to tune the sizes before ingesting for real.
//
//   node scripts/preview-chunks.mjs "../DrigDocuments/5550A-VM install instructions.pdf"
//   node scripts/preview-chunks.mjs some.pdf --blocks        # also dump structural blocks
//   node scripts/preview-chunks.mjs some.pdf --full          # print full chunk text
import fs from "node:fs/promises";
import path from "node:path";
import { extractDocumentBlocks } from "../src/services/chunking/pdfStructure.js";
import { extractDocxBlocks } from "../src/services/chunking/docxStructure.js";
import { buildChunkTree, estimateTokens } from "../src/services/chunking/chunker.js";

// Same values as params.js DEFAULT_CHUNK_PARAMS, duplicated here on purpose:
// importing params.js would pull in the DB pool.
const PARAMS = {
  childTargetTokens: 250,
  childMaxTokens: 380,
  childOverlapTokens: 30,
  procedureMaxTokens: 800,
  parentMinTokens: 150,
  parentMaxTokens: 1200,
};

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/preview-chunks.mjs <file.pdf|file.docx> [--blocks] [--full]");
  process.exit(1);
}

const showBlocks = flags.includes("--blocks");
const full = flags.includes("--full");
const clip = (text, n) => (full || text.length <= n ? text : `${text.slice(0, n).trimEnd()}…`);

const buffer = await fs.readFile(file);
const title = path.basename(file);
const isDocx = file.toLowerCase().endsWith(".docx");
const { totalPages, pages, blocks } = await (isDocx ? extractDocxBlocks(buffer) : extractDocumentBlocks(buffer));
const pageLabel = (from, to) => (from === null || from === undefined ? "no page" : from === to ? `p${from}` : `p${from}-${to}`);

console.log(
  isDocx
    ? `\n${title}: Word document, ${blocks.length} blocks`
    : `\n${title}: ${totalPages} pages, ${pages.filter((p) => !p.hasText).length} without a text layer, ${blocks.length} blocks`
);

if (showBlocks) {
  console.log("\n--- blocks ---");
  for (const b of blocks) {
    const label = b.type === "heading" ? `heading L${b.level}` : b.type;
    const body = b.type === "list" ? b.items.map((i) => `${i.marker} ${i.text}`).join(" / ") : (b.text ?? `(image #${b.imageIndex}, not yet described)`);
    console.log(`${pageLabel(b.page, b.pageEnd)} [${label}] ${clip(body.replace(/\n/g, "⏎"), 140)}`);
  }
}

const { parents, children } = await buildChunkTree(blocks, title, PARAMS);
const byParent = new Map();
for (const c of children) {
  if (!byParent.has(c.parentKey)) byParent.set(c.parentKey, []);
  byParent.get(c.parentKey).push(c);
}

console.log(`\n--- ${parents.length} parents, ${children.length} children ---`);
for (const p of parents) {
  console.log(`\nPARENT ${p.key}  ${pageLabel(p.pageFrom, p.pageTo)}  ~${estimateTokens(p.text)} tok  ${p.sectionPath}`);
  for (const c of byParent.get(p.key) ?? []) {
    const flags = [c.metadata.kind, c.metadata.hasWarning && "⚠warning", c.metadata.stepCount && `${c.metadata.stepCount} steps`, c.metadata.part]
      .filter(Boolean)
      .join(", ");
    console.log(`  └ CHILD #${c.chunkIndex}  ${pageLabel(c.pageFrom, c.pageTo)}  ~${estimateTokens(c.text)} tok  (${flags})`);
    console.log(`      ${clip(c.text.replace(/\n/g, "\n      "), 260)}`);
  }
}

const sizes = children.map((c) => estimateTokens(c.text)).sort((a, b) => a - b);
if (sizes.length) {
  console.log(
    `\nchild tokens: min ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes[sizes.length - 1]}; ` +
      `${children.filter((c) => c.metadata.hasWarning).length} carry a warning`
  );
}
