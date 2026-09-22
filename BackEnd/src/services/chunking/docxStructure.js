import mammoth from "mammoth";
import { parse } from "node-html-parser";
import { matchCallout } from "./textRules.js";

/**
 * Turns a Word (.docx) file into the same ordered structural blocks as
 * pdfStructure.js, so chunking, embedding, publishing and retrieval are shared.
 *
 * Unlike a PDF, Word carries real semantic markup: heading styles, lists and
 * tables are explicit, so this needs none of the layout guessing the PDF path
 * does. What it does NOT have is pages (a .docx is reflowed by whatever opens
 * it), so every block has `page: null` and answers are cited by section.
 *
 * Handled:
 *   - Heading 1-6 / Title / Subtitle styles -> headings
 *   - real numbered and bulleted lists -> lists (kept whole, like PDF procedures)
 *   - "1. Do this" typed by hand in separate paragraphs -> one numbered list
 *   - "WARNING: ..." paragraphs, and one-cell boxed tables -> callouts
 *   - tables -> rows joined with " | "
 *   - a short all-bold line followed by prose -> heading (for documents that
 *     bold their subheadings instead of using heading styles)
 *   - pictures -> `figure` placeholder blocks (bytes returned in `images`), later
 *     described by the vision model in visualEnrichment.js
 * Not handled: diagrams drawn with Word's own shapes (they are not pictures, and
 * there is no renderer to screenshot them), text boxes, headers/footers, and
 * pictures inside tables or list items. Tables themselves are read from their
 * markup, which is exact, so they are not sent to vision.
 */

const TYPED_ITEM_RE = /^(\d{1,3})[.)]\s+(?=\S)/;
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const IMAGE_MARKER = "docx-image:";
// What the vision API accepts. EMF/WMF/TIFF/SVG (common in Word) are skipped.
const VISION_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// Below this it is a bullet or an icon, not a diagram.
const MIN_IMAGE_BYTES = 4096;

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
];

const clean = (text) => text.replace(/\s+/g, " ").trim();
const tagOf = (node) => node.tagName?.toLowerCase() ?? null;
const isElement = (node) => Boolean(node.tagName);

const isSentenceEnd = (text) => /[.!?]$/.test(text.replace(/:$/, ""));

/** A paragraph that is entirely one bold run, e.g. "Mounting the unit". */
const isBoldOnly = (el) => {
  const html = el.innerHTML.trim();
  return html.startsWith("<strong>") && html.endsWith("</strong>") && (html.match(/<strong>/g) ?? []).length === 1;
};

/** Text of an <li> without its nested lists (those are collected separately). */
const ownText = (li) => clean(li.childNodes.filter((n) => !["ul", "ol"].includes(tagOf(n) ?? "")).map((n) => n.text).join(" "));

const collectListItems = (listEl, ordered, items, depth = 0) => {
  let n = 0;
  for (const li of listEl.childNodes.filter((c) => tagOf(c) === "li")) {
    const text = ownText(li);
    if (text) {
      n++;
      // Nested items are indented by depth so their place in the procedure survives.
      const marker = depth === 0 && ordered ? `${n}.` : `${"  ".repeat(depth)}•`;
      items.push({ text, marker });
    }
    for (const nested of li.childNodes.filter((c) => ["ul", "ol"].includes(tagOf(c) ?? ""))) {
      collectListItems(nested, tagOf(nested) === "ol", items, depth + 1);
    }
  }
};

const tableRows = (table) =>
  table
    .querySelectorAll("tr")
    .map((tr) => tr.querySelectorAll("th,td").map((cell) => clean(cell.text)).join(" | "))
    .filter((row) => row.replace(/\|/g, "").trim().length > 0);

/**
 * @returns {Promise<{ totalPages: number, pages: object[], blocks: object[] }>}
 *   `totalPages` is 1: a Word file is one continuous flow, tracked as a single
 *   unit for progress. Blocks carry no page numbers.
 */
export const extractDocxBlocks = async (buffer) => {
  // Every embedded picture is kept (bytes + type) so it can be described by the
  // vision model; the HTML only carries a marker saying where it sits.
  const images = [];
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: STYLE_MAP,
      convertImage: mammoth.images.imgElement(async (image) => {
        const bytes = await image.read();
        images.push({ buffer: bytes, contentType: image.contentType });
        return { src: `${IMAGE_MARKER}${images.length - 1}` };
      }),
    }
  );

  const root = parse(html);
  const elements = root.childNodes.filter(isElement);
  const hasImage = images.length > 0;

  const blocks = [];
  let typedList = null; // consecutive hand-numbered paragraphs, gathered into one list
  let pendingCallout = null; // a lone "WARNING" line whose text is in the next paragraph

  const push = (block) => blocks.push({ ...block, page: null, pageEnd: null });
  const flushTypedList = () => {
    if (typedList) push(typedList);
    typedList = null;
  };

  elements.forEach((el, index) => {
    const tag = tagOf(el);

    if (HEADING_TAGS.has(tag)) {
      flushTypedList();
      const text = clean(el.text);
      if (text) push({ type: "heading", text, size: 0, level: Math.min(4, Number(tag[1])) });
      return;
    }

    if (tag === "p") {
      // A picture in this paragraph becomes a figure block at this position, so its
      // description lands in the right section. Tiny images (bullets, icons) and
      // formats a vision model cannot read are left out.
      for (const img of el.querySelectorAll("img")) {
        const src = img.getAttribute("src") ?? "";
        if (!src.startsWith(IMAGE_MARKER)) continue;
        const index = Number(src.slice(IMAGE_MARKER.length));
        const image = images[index];
        if (image && VISION_IMAGE_TYPES.has(image.contentType) && image.buffer.length >= MIN_IMAGE_BYTES) {
          flushTypedList();
          push({ type: "figure", sourceKind: "docx_image", imageIndex: index });
        }
      }

      const text = clean(el.text);
      if (!text) return;

      if (pendingCallout) {
        flushTypedList();
        push({ type: "callout", calloutKind: pendingCallout, text });
        pendingCallout = null;
        return;
      }

      const callout = matchCallout(text);
      if (callout) {
        flushTypedList();
        if (callout.rest) push({ type: "callout", calloutKind: callout.kind, text: callout.rest });
        else pendingCallout = callout.kind;
        return;
      }

      const typed = text.match(TYPED_ITEM_RE);
      if (typed) {
        const number = parseInt(typed[1], 10);
        const item = { text: text.slice(typed[0].length), marker: `${number}.` };
        if (typedList && number === typedList.lastNumber + 1) {
          typedList.items.push(item);
          typedList.lastNumber = number;
        } else {
          flushTypedList();
          typedList = { type: "list", ordered: true, lastNumber: number, items: [item] };
        }
        return;
      }

      flushTypedList();

      const next = elements[index + 1];
      const proseFollows = next && ["p", "ol", "ul"].includes(tagOf(next) ?? "") && clean(next.text).length >= 20;
      if (isBoldOnly(el) && text.length <= 80 && !isSentenceEnd(text) && /[A-Za-z]{3}/.test(text) && proseFollows) {
        push({ type: "heading", text: text.replace(/:$/, ""), size: 0, level: 4 });
      } else {
        push({ type: "paragraph", text });
      }
      return;
    }

    if (tag === "ol" || tag === "ul") {
      flushTypedList();
      const items = [];
      collectListItems(el, tag === "ol", items);
      if (items.length > 0) push({ type: "list", ordered: tag === "ol", lastNumber: items.length, items });
      return;
    }

    if (tag === "table") {
      flushTypedList();
      const rows = tableRows(el);
      if (rows.length === 0) return;

      // A warning drawn as a one-cell shaded box is a table in Word.
      const callout = rows.length === 1 && !rows[0].includes("|") ? matchCallout(rows[0]) : null;
      if (callout?.rest) push({ type: "callout", calloutKind: callout.kind, text: callout.rest });
      else push({ type: "table", text: rows.join("\n") });
    }
  });

  flushTypedList();

  return {
    totalPages: 1,
    pages: [{ pageNumber: 1, hasVisualContent: hasImage, hasText: blocks.length > 0 }],
    blocks,
    images,
  };
};
