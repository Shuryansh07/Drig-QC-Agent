import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { matchCallout } from "./textRules.js";

/**
 * Turns a PDF into an ordered list of structural blocks (headings, paragraphs,
 * numbered/bulleted lists, warning callouts, tables, captions), each tagged
 * with its page. pdf-parse's getText() returns flat text with no font
 * information, so headings and columns are unrecoverable from it — this reads
 * pdfjs text items directly (position + font size) instead.
 *
 * Heuristic by design: PDFs carry no semantic markup. What it handles:
 *   - multi-column and mixed layouts (DRIG manuals are often multi-panel): the
 *     page is split recursively (XY-cut) on empty gutters / whitespace bands and
 *     read region by region
 *   - running headers / footers ("Page 3 of 6") are dropped
 *   - headings: larger-than-body type, dotted numbering ("4.3 Power"), or a
 *     short ALL-CAPS line that is followed by prose
 *   - numbered procedures stay ONE block, even across a column or page break
 *   - WARNING / CAUTION / NOTE boxes become their own `callout` block
 * What it does not handle: scanned pages (no text layer -> no blocks), text
 * inside diagrams (kept as short paragraphs, not headings), and tables are only
 * recognised when cells share a baseline.
 */

const CAPTION_RE = /^(FIGURE|FIG\.?|TABLE|DIAGRAM|PHOTO|IMAGE)\s*[A-Z]?\d+/i;
const NUM_ITEM_RE = /^(\d{1,3})[.)]\s+(?=\S)/;
const STEP_ITEM_RE = /^Step\s+(\d{1,3})\s*[:.)\-–]\s*/i;
const BULLET_RE = /^[•●▪■◦‣▸►]\s*(?=\S)|^[-–—]\s+(?=[A-Za-z]{2,})/;
const DOTTED_HEADING_RE = /^(\d+(?:\.\d+)+)[.)]?\s+[A-Z][A-Za-z]/;
// "18.9 Watts Max" or "1.5 Amps" is a measurement, not section 18.9.
const MEASUREMENT_RE = /^\d+(?:\.\d+)+\s*(?:watts?|amps?|volts?|vdc|vac|v|a|mm|cm|in|inch|lbs?|kg|hz|ohms?|awg|ft|nm|psi|mph|fpm)\b/i;
const PAGE_NUMBER_RE = /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i;
// Type at least this much larger than body text is a heading outright. Smaller
// jumps (and bold) are only trusted when prose follows, see classifyLines().
const HEADING_SIZE_RATIO = 1.3;
const BOLD_FONT_RE = /bold|black|heavy|semibold|demi/i;
// Bold marks headings only if it is rare; some manuals set the body itself in bold.
const MAX_BOLD_SHARE_FOR_HEADINGS = 0.35;

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const sameSize = (a, b) => Math.abs(a - b) < 0.05;

// ---- per-page text items -> reading-order regions -> lines ------------------

const toItems = (textContent) =>
  textContent.items
    .filter((it) => typeof it.str === "string" && it.str.trim() !== "" && Math.abs(it.transform[1]) < 0.01)
    .map((it) => ({
      // A symbol font's bullet comes out of pdfjs as U+0000. Postgres cannot store it, and it IS a bullet.
      str: it.str.replace(/\u0000/g, "•"),
      x: it.transform[4],
      y: it.transform[5],
      width: it.width || 0,
      size: it.height || Math.abs(it.transform[3]) || 1,
      fontName: it.fontName,
    }));

/** Empty stretches along one axis. `intervals` are [start, end] pairs. */
const findGaps = (intervals, minGap) => {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let reach = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i];
    if (start - reach >= minGap) gaps.push({ at: (reach + start) / 2, size: start - reach });
    reach = Math.max(reach, end);
  }
  return gaps;
};

/**
 * XY-cut: split on the widest empty vertical gutter if there is one (columns),
 * else on the widest empty horizontal band, and recurse. Returns regions in
 * reading order (left before right, top before bottom). Handles pages that mix
 * a full-width block with a multi-column body, which one page-wide gutter can't.
 */
const readingRegions = (items, pageWidth) => {
  const minGapX = Math.max(12, pageWidth * 0.04);

  const cut = (region) => {
    if (region.length < 6) return [region];

    const sizes = region.map((i) => i.size);
    const minGapY = Math.max(4, median(sizes) * 1.5);

    const xGaps = findGaps(region.map((i) => [i.x, i.x + i.width]), minGapX).filter((gap) => {
      const left = region.filter((i) => i.x + i.width / 2 < gap.at).length;
      return left >= 3 && region.length - left >= 3;
    });
    if (xGaps.length) {
      const gap = xGaps.reduce((a, b) => (b.size > a.size ? b : a));
      return [
        ...cut(region.filter((i) => i.x + i.width / 2 < gap.at)),
        ...cut(region.filter((i) => i.x + i.width / 2 >= gap.at)),
      ];
    }

    const yGaps = findGaps(region.map((i) => [i.y - i.size * 0.25, i.y + i.size]), minGapY);
    if (yGaps.length) {
      const gap = yGaps.reduce((a, b) => (b.size > a.size ? b : a));
      const top = region.filter((i) => i.y >= gap.at);
      const bottom = region.filter((i) => i.y < gap.at);
      if (top.length && bottom.length) return [...cut(top), ...cut(bottom)];
    }

    return [region];
  };

  return cut(items);
};

const joinItems = (lineItems) => {
  let text = "";
  let prev = null;
  for (const it of lineItems) {
    if (prev) {
      const gap = it.x - (prev.x + prev.width);
      const size = Math.max(it.size, prev.size);
      // A wide gap on one baseline is a table cell boundary, not a word space.
      if (gap > 2 * size) text += " | ";
      else if (gap > 0.12 * size && !text.endsWith(" ") && !it.str.startsWith(" ")) text += " ";
    }
    text += it.str;
    prev = it;
  }
  return text.replace(/\s+/g, " ").trim();
};

/**
 * The type size carrying most of a line's characters. Not the maximum: a large
 * warning-icon glyph ("!") on the same baseline would otherwise make an
 * ordinary sentence look like a heading.
 */
const dominantItemSize = (lineItems) => {
  const weight = new Map();
  for (const it of lineItems) {
    const key = Math.round(it.size * 10) / 10;
    weight.set(key, (weight.get(key) ?? 0) + it.str.length);
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

const groupLines = (items, page, region, boldFonts) => {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = null;

  for (const it of sorted) {
    if (current && Math.abs(it.y - current.y) <= Math.max(1, 0.35 * it.size)) {
      current.items.push(it);
    } else {
      current = { y: it.y, items: [it] };
      lines.push(current);
    }
  }

  return lines.map((l) => {
    const ordered = l.items.sort((a, b) => a.x - b.x);
    return {
      text: joinItems(ordered),
      x: ordered[0].x,
      y: l.y,
      size: dominantItemSize(ordered),
      charCount: ordered.reduce((n, i) => n + i.str.length, 0),
      bold: ordered.every((i) => boldFonts.has(i.fontName)),
      page,
      column: region,
    };
  });
};

// ---- running headers / footers ---------------------------------------------

const normaliseForRepeat = (text) => text.toLowerCase().replace(/\d+/g, "#").trim();

const dropRunningHeadersAndFooters = (pageLines, pageHeights) => {
  const numPages = pageLines.length;
  const counts = new Map();
  const inBand = (line, height) => line.y > height * 0.93 || line.y < height * 0.07;

  pageLines.forEach((lines, i) => {
    const seen = new Set();
    for (const line of lines) {
      if (!inBand(line, pageHeights[i])) continue;
      const key = normaliseForRepeat(line.text);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  });

  const repeatThreshold = Math.max(2, Math.ceil(numPages * 0.3));

  return pageLines.map((lines, i) =>
    lines.filter((line) => {
      if (!inBand(line, pageHeights[i])) return true;
      if (PAGE_NUMBER_RE.test(line.text.trim())) return false;
      return numPages < 3 || (counts.get(normaliseForRepeat(line.text)) ?? 0) < repeatThreshold;
    })
  );
};

// ---- lines -> classified lines ---------------------------------------------

const isEndOfSentence = (text) => /[.!?]$/.test(text.replace(/:$/, ""));

const classifyLine = (line, { bodySize, boldShare }) => {
  // A leading icon glyph ("⚠ WARNING!") must not hide the keyword.
  const text = line.text.replace(/^[^A-Za-z0-9•●▪■◦‣▸►\-–—]+/, "");

  const callout = matchCallout(text);
  if (callout) return { type: "callout", calloutKind: callout.kind, rest: callout.rest };

  if (CAPTION_RE.test(text)) return { type: "caption" };

  const letters = text.replace(/[^A-Za-z]/g, "");
  const shortLine = text.length <= 90 && !isEndOfSentence(text);

  if (line.size >= bodySize * HEADING_SIZE_RATIO && shortLine && letters.length >= 3) return { type: "heading", basis: "size" };
  if (DOTTED_HEADING_RE.test(text) && !MEASUREMENT_RE.test(text) && text.length <= 100 && !isEndOfSentence(text)) {
    return { type: "heading", basis: "numbered" };
  }

  const numbered = text.match(NUM_ITEM_RE) || text.match(STEP_ITEM_RE);
  if (numbered && !text.includes(" | ")) {
    return { type: "item", marker: "num", number: parseInt(numbered[1], 10), rest: text.slice(numbered[0].length) };
  }
  const bullet = text.match(BULLET_RE);
  if (bullet && !text.includes(" | ")) return { type: "item", marker: "bullet", rest: text.slice(bullet[0].length) };

  if (letters.length >= 4 && text.length <= 60 && letters === letters.toUpperCase() && !isEndOfSentence(text)) {
    return { type: "heading", basis: "caps" };
  }
  if (line.bold && boldShare < MAX_BOLD_SHARE_FOR_HEADINGS && shortLine && letters.length >= 3) {
    return { type: "heading", basis: "bold" };
  }

  return { type: "text" };
};

/**
 * Classifies every line, then demotes heading candidates that are really
 * something else: a run of 3+ same-size "headings" is body text set in a
 * different face (legal fine print), and an ALL-CAPS or bold-only line is only
 * a heading if prose follows it — diagram labels ("BLUE WIRE", "PIN 3") are
 * followed by more labels.
 */
const classifyLines = (lines, pageStats, pitch) => {
  const kinds = lines.map((line) => classifyLine(line, pageStats.get(line.page)));
  const sameFlow = (a, b) => a && b && a.page === b.page && a.column === b.column;

  for (let i = 0; i < lines.length; i++) {
    if (kinds[i].type !== "heading" || !["caps", "bold"].includes(kinds[i].basis)) continue;
    const next = lines[i + 1];
    const nextKind = kinds[i + 1];
    const proseFollows =
      sameFlow(lines[i], next) &&
      lines[i].y - next.y <= pitch * 2.5 &&
      (nextKind.type === "text" || nextKind.type === "item" || nextKind.type === "callout") &&
      next.text.length >= 20 &&
      /[a-z]/.test(next.text);
    if (!proseFollows) kinds[i] = { type: "text" };
  }

  for (let i = 0; i < lines.length; ) {
    if (kinds[i].type !== "heading") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && kinds[j].type === "heading" && sameFlow(lines[i], lines[j]) && sameSize(lines[i].size, lines[j].size)) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) kinds[k] = { type: "text" };
    i = j;
  }

  return kinds;
};

// ---- classified lines -> blocks ---------------------------------------------

const cleanHeadingText = (text) => text.replace(/[:\s]+$/, "").trim();

// A line ending in "-" joins to the next without a space ("vacuum-" + "magnet").
function joinLine(acc, next) {
  if (!acc) return next;
  return acc.endsWith("-") ? acc + next : `${acc} ${next}`;
}

const buildBlocks = (lines, kinds, { pitch }) => {
  const paraGap = pitch * 1.55;
  const blocks = [];
  let open = null; // paragraph | callout | list being accumulated
  let prevLine = null;

  const close = () => {
    if (!open) return;
    if (open.type === "paragraph") {
      const cellRows = open.lines.filter((t) => t.includes(" | ")).length;
      if (open.lines.length >= 2 && cellRows / open.lines.length >= 0.5) {
        blocks.push({ type: "table", text: open.lines.join("\n"), page: open.page, pageEnd: open.pageEnd });
      } else {
        blocks.push({
          type: "paragraph",
          text: open.lines.reduce(joinLine, ""),
          page: open.page,
          pageEnd: open.pageEnd,
          column: open.column,
        });
      }
    } else if (open.type === "callout") {
      blocks.push({
        type: "callout",
        calloutKind: open.calloutKind,
        text: open.lines.reduce(joinLine, "").trim(),
        page: open.page,
        pageEnd: open.pageEnd,
      });
    } else if (!open.resumed) {
      blocks.push(open.block);
    }
    open = null;
  };

  lines.forEach((line, index) => {
    const kind = kinds[index];
    const brokeLayout = !prevLine || prevLine.page !== line.page || prevLine.column !== line.column || prevLine.y - line.y > paraGap;
    const inCallout = open?.type === "callout" && !brokeLayout;

    if (kind.type === "heading" && !inCallout) {
      close();
      const last = blocks[blocks.length - 1];
      if (last?.type === "heading" && last.page === line.page && sameSize(last.size, line.size) && !brokeLayout) {
        last.text = cleanHeadingText(`${last.text} ${line.text}`);
      } else {
        blocks.push({ type: "heading", text: cleanHeadingText(line.text), size: line.size, page: line.page, pageEnd: line.page });
      }
    } else if (kind.type === "callout") {
      close();
      open = { type: "callout", calloutKind: kind.calloutKind, lines: kind.rest ? [kind.rest] : [], page: line.page, pageEnd: line.page };
    } else if (kind.type === "caption") {
      close();
      blocks.push({ type: "caption", text: line.text, page: line.page, pageEnd: line.page });
    } else if (kind.type === "item" && !inCallout) {
      const isNum = kind.marker === "num";
      const marker = isNum ? `${kind.number}.` : "•";
      const openList = open?.type === "list" ? open.block : null;
      // The list to resume: the last block, looking past figure captions
      // ("Figure 4.") that sit between steps.
      let tail = blocks.length - 1;
      while (tail >= 0 && blocks[tail].type === "caption") tail--;
      const resumable = openList ?? (blocks[tail]?.type === "list" ? blocks[tail] : null);

      // A numbered procedure resumes across a column/page break or a figure gap
      // as long as the step number is the next one; a bullet list needs adjacency.
      const continues =
        resumable && resumable.ordered === isNum && (isNum ? kind.number === resumable.lastNumber + 1 : openList && !brokeLayout);

      if (continues) {
        // Already in `blocks`; close() must not push it a second time.
        if (!openList) open = { type: "list", block: resumable, resumed: true };
        resumable.items.push({ text: kind.rest, marker });
        resumable.lastNumber = kind.number ?? resumable.lastNumber;
        resumable.pageEnd = line.page;
      } else {
        close();
        open = {
          type: "list",
          block: {
            type: "list",
            ordered: isNum,
            lastNumber: kind.number ?? 0,
            items: [{ text: kind.rest, marker }],
            page: line.page,
            pageEnd: line.page,
          },
        };
      }
    } else if (open && !brokeLayout) {
      // Plain text line continues whatever is open.
      if (open.type === "list") {
        const item = open.block.items[open.block.items.length - 1];
        item.text = joinLine(item.text, line.text);
        open.block.pageEnd = line.page;
      } else {
        open.lines.push(line.text);
        open.pageEnd = line.page;
      }
    } else {
      close();
      open = { type: "paragraph", lines: [line.text], page: line.page, pageEnd: line.page, column: line.column };
    }

    prevLine = line;
  });
  close();

  return blocks;
};

/** A paragraph cut by a column or page break resumes lower-case in the next block. */
const mergeSplitParagraphs = (blocks) => {
  const merged = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    const layoutBroke = prev && (block.page !== prev.pageEnd || block.column !== prev.column);
    if (
      prev?.type === "paragraph" &&
      block.type === "paragraph" &&
      layoutBroke &&
      !/[.!?:;)”"]$/.test(prev.text) &&
      /^[a-z0-9(]/.test(block.text)
    ) {
      prev.text = joinLine(prev.text, block.text);
      prev.pageEnd = block.pageEnd;
    } else {
      merged.push(block);
    }
  }
  return merged;
};

/** Heading depth: dotted numbering if present, else rank of its type size among all headings. */
const assignHeadingLevels = (blocks) => {
  const sizes = [...new Set(blocks.filter((b) => b.type === "heading").map((b) => Math.round(b.size * 10) / 10))].sort((a, b) => b - a);
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    const dotted = block.text.match(/^(\d+(?:\.\d+)*)[.)]?\s/);
    const rank = sizes.findIndex((s) => sameSize(s, block.size));
    block.level = dotted ? Math.min(4, dotted[1].split(".").length) : Math.min(4, Math.max(rank, 0) + 1);
  }
  return blocks;
};

// ---- entry point -------------------------------------------------------------

const IMAGE_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].filter((op) => op !== undefined));

/** Reads the page's operator list once: whether it paints an image, and which fonts are bold. */
const imageSize = (args) =>
  typeof args?.[1] === "number" && typeof args?.[2] === "number"
    ? [args[1], args[2]]
    : [args?.[0]?.width ?? 0, args?.[0]?.height ?? 0];

const inspectPage = async (page, textContent) => {
  const boldFonts = new Set();
  let hasImage = false;
  // Raw signals for deciding whether a page needs a vision pass (visualEnrichment.js):
  // the smaller side of each embedded image, and how many vector paths are drawn.
  // A wiring diagram drawn as vectors has no embedded image at all, only paths.
  const imageMinDims = [];
  let pathOps = 0;
  try {
    const ops = await page.getOperatorList();
    ops.fnArray.forEach((fn, i) => {
      if (IMAGE_OPS.has(fn)) {
        hasImage = true;
        const [w, h] = imageSize(ops.argsArray[i]);
        imageMinDims.push(Math.min(w, h));
      } else if (fn === OPS.constructPath) {
        pathOps++;
      }
    });
    // Real font names ("Arial-BoldMT") only resolve after the operator list loads.
    for (const id of Object.keys(textContent.styles ?? {})) {
      if (page.commonObjs.has(id) && BOLD_FONT_RE.test(page.commonObjs.get(id)?.name ?? "")) boldFonts.add(id);
    }
  } catch {
    // Bold/image detection is best-effort; headings then fall back to size alone.
  }
  return { hasImage, boldFonts, imageMinDims, pathOps };
};

/** Body type size = the size carrying the most characters. */
const dominantSize = (lines, fallback) => {
  const weight = new Map();
  for (const l of lines) {
    const key = Math.round(l.size * 10) / 10;
    weight.set(key, (weight.get(key) ?? 0) + l.charCount);
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
};

/**
 * @returns {Promise<{ totalPages: number, pages: {pageNumber:number, hasVisualContent:boolean, hasText:boolean}[], blocks: object[] }>}
 */
export const extractDocumentBlocks = async (buffer) => {
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  try {
    const totalPages = pdf.numPages;
    if (!totalPages || totalPages < 1) throw new Error("PDF has no pages");

    const pageLines = [];
    const pageHeights = [];
    const pages = [];

    for (let n = 1; n <= totalPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const items = toItems(textContent);
      const { hasImage, boldFonts, imageMinDims, pathOps } = await inspectPage(page, textContent);

      const regions = items.length ? readingRegions(items, viewport.width) : [];
      pageLines.push(regions.flatMap((region, index) => groupLines(region, n, index, boldFonts)));
      pageHeights.push(viewport.height);
      pages.push({
        pageNumber: n,
        hasVisualContent: hasImage,
        hasText: items.length > 0,
        signals: { imageMinDims, pathOps },
      });
      page.cleanup();
    }

    const lines = dropRunningHeadersAndFooters(pageLines, pageHeights).flat();

    // Body size is judged per page: a page of fine print is set in a different
    // size than the rest, and comparing it to the document-wide body size would
    // make every line of it look like a heading.
    const globalBody = dominantSize(lines, 10);
    const pageStats = new Map();
    for (let n = 1; n <= totalPages; n++) {
      const onPage = lines.filter((l) => l.page === n);
      const chars = onPage.reduce((sum, l) => sum + l.charCount, 0) || 1;
      pageStats.set(n, {
        bodySize: onPage.length >= 5 ? dominantSize(onPage, globalBody) : globalBody,
        boldShare: onPage.filter((l) => l.bold).reduce((sum, l) => sum + l.charCount, 0) / chars,
      });
    }

    // Typical baseline-to-baseline distance inside body text.
    const steps = [];
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1];
      const b = lines[i];
      const step = a.y - b.y;
      const body = pageStats.get(b.page).bodySize;
      if (a.page === b.page && a.column === b.column && step > 0 && step < body * 3 && sameSize(b.size, body)) steps.push(step);
    }
    const pitch = median(steps) || globalBody * 1.2;

    const kinds = classifyLines(lines, pageStats, pitch);
    const blocks = assignHeadingLevels(mergeSplitParagraphs(buildBlocks(lines, kinds, { pitch })));
    return { totalPages, pages, blocks };
  } finally {
    await pdf.destroy();
  }
};
