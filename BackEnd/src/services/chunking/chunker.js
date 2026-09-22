import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FIGURE_MARKER } from "./textRules.js";

/**
 * Parent/child chunking over the structural blocks from pdfStructure.js
 * (DATABASE.md §6.1: "the child chunk was only the match — send the parent to
 * the model").
 *
 *   parent = one heading section (or a few tiny ones merged, or one part of a
 *            very long one). Never embedded, never searchable. This is what the
 *            answer model reads.
 *   child  = a small retrieval unit inside a parent. Embedded + keyword-indexed.
 *
 * Rules the Blueprint (§5.2) makes non-negotiable, enforced here:
 *   - A numbered procedure is never split between steps. It stays one child, up
 *     to `procedureMaxTokens`; only past that does it split, and only at step
 *     boundaries.
 *   - A warning/caution box is attached to the procedure it belongs to: its
 *     text is copied INTO that procedure's child, so retrieving the steps
 *     retrieves the warning. Standalone warnings become their own child.
 *
 * LangChain's RecursiveCharacterTextSplitter is used only for the one job it
 * is good at here: cutting an over-long PROSE paragraph at sentence/word
 * boundaries with overlap. Everything structural is ours, because no library
 * knows that step 4 and step 7 must stay together.
 */

export const CHUNKER_VERSION = "v1";

// Rough English/technical-text estimate. Good enough for size budgets; the
// embedding API does the real tokenising.
const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

const MIN_PROSE_TOKENS = 40;

const renderBlock = (block) => {
  switch (block.type) {
    case "heading":
      return block.text;
    case "list":
      return block.items.map((item) => `${item.marker} ${item.text}`).join("\n");
    case "callout":
      return `${block.calloutKind.toUpperCase()}: ${block.text}`;
    case "figure":
      return `${FIGURE_MARKER}\n${block.text}`;
    default:
      return block.text;
  }
};

// ---- sections -> parents -----------------------------------------------------

/** Walks blocks keeping a heading stack; tags each block with its section path. */
const assignSectionPaths = (blocks, title) => {
  const stack = []; // { level, text }
  const sections = [];
  let current = null;

  const pathOf = () => (stack.length ? stack.map((h) => h.text).join(" > ") : title);

  for (const block of blocks) {
    if (block.type === "heading") {
      while (stack.length && stack[stack.length - 1].level >= block.level) stack.pop();
      stack.push({ level: block.level, text: block.text });
      current = { path: pathOf(), blocks: [] };
      sections.push(current);
    } else if (!current) {
      current = { path: pathOf(), blocks: [] };
      sections.push(current);
    }
    current.blocks.push({ ...block, sectionPath: current.path });
  }

  return sections;
};

const buildParents = (sections, { parentMinTokens, parentMaxTokens }) => {
  const parents = [];
  let current = { blocks: [], tokens: 0 };

  const flush = () => {
    if (current.blocks.length) parents.push(current);
    current = { blocks: [], tokens: 0 };
  };

  for (const section of sections) {
    // A parent that has already reached its minimum ends at a section boundary;
    // a tiny one (e.g. a chapter title with no body) rolls into the next section.
    if (current.tokens >= parentMinTokens) flush();

    for (const block of section.blocks) {
      const tokens = estimateTokens(renderBlock(block));
      if (current.blocks.length && current.tokens + tokens > parentMaxTokens) flush();
      current.blocks.push(block);
      current.tokens += tokens;
    }
  }
  flush();

  return parents;
};

// ---- parent -> children ------------------------------------------------------

/**
 * Pre-pass: a callout directly before a list attaches to it (as `before`); one
 * directly after a list attaches to that list (as `after`). Callouts with
 * neither stay standalone.
 */
const attachCallouts = (blocks) => {
  const units = [];
  let pending = [];

  for (const block of blocks) {
    if (block.type === "callout") {
      pending.push(block);
      continue;
    }
    if (block.type === "list") {
      units.push({ type: "list", block, before: pending, after: [] });
      pending = [];
      continue;
    }
    for (const orphan of pending) units.push({ type: "callout", block: orphan });
    pending = [];
    units.push({ type: block.type, block });
  }

  // Trailing callouts: attach to the list just before them, else standalone.
  const last = units[units.length - 1];
  for (const callout of pending) {
    if (last?.type === "list") last.after.push(callout);
    else units.push({ type: "callout", block: callout });
  }

  return units;
};

/** Page range of some blocks; both null for formats with no pages (Word), which cite by section instead. */
const pageSpan = (blocks) => {
  const pages = blocks.flatMap((b) => [b.page, b.pageEnd ?? b.page]).filter((p) => p !== null && p !== undefined);
  return pages.length > 0 ? { pageFrom: Math.min(...pages), pageTo: Math.max(...pages) } : { pageFrom: null, pageTo: null };
};

const splitListByItems = (items, maxTokens) => {
  const groups = [];
  let group = [];
  let tokens = 0;
  for (const item of items) {
    const t = estimateTokens(`${item.marker} ${item.text}`);
    if (group.length && tokens + t > maxTokens) {
      groups.push(group);
      group = [];
      tokens = 0;
    }
    group.push(item);
    tokens += t;
  }
  if (group.length) groups.push(group);
  return groups;
};

/**
 * A table too big for one chunk is split by row groups with its header row
 * repeated, and done BEFORE parents are built so the parts can land in
 * different parents too (a block is never divided across parents).
 */
const explodeOversizedTables = (blocks, maxTokens) =>
  blocks.flatMap((block) => {
    if (block.type !== "table" || estimateTokens(block.text) <= maxTokens) return [block];
    return splitTableByRows(block.text, maxTokens).map((text) => ({ ...block, text }));
  });

const splitTableByRows = (text, maxTokens) => {
  const [header, ...rows] = text.split("\n");
  const groups = [];
  let group = [];
  let tokens = estimateTokens(header);
  for (const row of rows) {
    const t = estimateTokens(row);
    if (group.length && tokens + t > maxTokens) {
      groups.push(group);
      group = [];
      tokens = estimateTokens(header);
    }
    group.push(row);
    tokens += t;
  }
  if (group.length) groups.push(group);
  // The header row repeats in every part so each is readable on its own.
  return groups.map((g) => [header, ...g].join("\n"));
};

const buildChildPieces = async (blocks, params, splitter) => {
  const { childTargetTokens, childMaxTokens, procedureMaxTokens } = params;
  const pieces = [];
  let prose = null;

  const flushProse = () => {
    if (prose) pieces.push(prose);
    prose = null;
  };

  const addProse = (text, block) => {
    const tokens = estimateTokens(text);
    if (prose && prose.tokens + tokens > childTargetTokens) flushProse();
    if (!prose) prose = { kind: "prose", body: text, tokens, blocks: [block], hasWarning: false };
    else {
      prose.body += `\n\n${text}`;
      prose.tokens += tokens;
      prose.blocks.push(block);
    }
  };

  for (const unit of attachCallouts(blocks)) {
    const { block } = unit;

    if (unit.type === "heading") continue; // carried by the child's section-path header

    if (unit.type === "paragraph" || unit.type === "caption") {
      const tokens = estimateTokens(block.text);
      if (tokens > childMaxTokens) {
        flushProse();
        for (const part of await splitter.splitText(block.text)) {
          pieces.push({ kind: "prose", body: part, tokens: estimateTokens(part), blocks: [block], hasWarning: false });
        }
      } else {
        addProse(block.text, block);
      }
      continue;
    }

    flushProse();

    if (unit.type === "figure") {
      // Its own child, never merged into prose: a machine-written description must stay
      // identifiable. A long one (a big table) splits at sentence/line boundaries, and the
      // marker is repeated on every part so no part can be mistaken for the manual's text.
      const parts = estimateTokens(block.text) > childMaxTokens ? await splitter.splitText(block.text) : [block.text];
      for (const part of parts) {
        const body = `${FIGURE_MARKER}\n${part}`;
        pieces.push({ kind: "figure", body, tokens: estimateTokens(body), blocks: [block], hasWarning: false, visualType: block.visualType });
      }
      continue;
    }

    if (unit.type === "callout") {
      pieces.push({ kind: "callout", body: renderBlock(block), tokens: estimateTokens(renderBlock(block)), blocks: [block], hasWarning: true });
      continue;
    }

    if (unit.type === "table") {
      // Oversized tables were already split by row in explodeOversizedTables().
      pieces.push({ kind: "table", body: block.text, tokens: estimateTokens(block.text), blocks: [block], hasWarning: false });
      continue;
    }

    if (unit.type === "list") {
      const before = unit.before.map(renderBlock);
      const after = unit.after.map(renderBlock);
      const allBlocks = [...unit.before, block, ...unit.after];
      const totalTokens = estimateTokens([...before, renderBlock(block), ...after].join("\n\n"));
      const groups = totalTokens > procedureMaxTokens ? splitListByItems(block.items, procedureMaxTokens) : [block.items];

      groups.forEach((items, index) => {
        const steps = items.map((item) => `${item.marker} ${item.text}`).join("\n");
        // Warnings are repeated in every part so no part of a split procedure loses them.
        const body = [...before, steps, ...after].join("\n\n");
        pieces.push({
          kind: block.ordered ? "procedure" : "list",
          body,
          tokens: estimateTokens(body),
          blocks: allBlocks,
          hasWarning: before.length + after.length > 0,
          stepCount: items.length,
          part: groups.length > 1 ? `${index + 1}/${groups.length}` : undefined,
        });
      });
      continue;
    }

    // Any block type not handled above still must not be lost.
    addProse(renderBlock(block), block);
  }
  flushProse();

  // A tiny prose remainder folds into the previous prose piece instead of standing alone.
  const merged = [];
  for (const piece of pieces) {
    const prev = merged[merged.length - 1];
    if (prev?.kind === "prose" && piece.kind === "prose" && piece.tokens < MIN_PROSE_TOKENS && prev.tokens + piece.tokens <= childMaxTokens) {
      prev.body += `\n\n${piece.body}`;
      prev.tokens += piece.tokens;
      prev.blocks.push(...piece.blocks);
    } else {
      merged.push(piece);
    }
  }
  return merged;
};

// ---- entry point -------------------------------------------------------------

/**
 * @param {object[]} blocks   from extractDocumentBlocks()
 * @param {string}   title    document title, used in every child's context header
 * @param {object}   params   sizes in tokens (from the `setting` table, INV-4):
 *   childTargetTokens, childMaxTokens, childOverlapTokens, procedureMaxTokens,
 *   parentMinTokens, parentMaxTokens
 * @returns {Promise<{parents: object[], children: object[]}>}
 *   Parents and children carry a shared `chunkIndex` sequence (document order:
 *   a parent, then its children) so (doc_id, page_from, chunk_index) is unique
 *   and re-chunking the same PDF is deterministic.
 */
export const buildChunkTree = async (blocks, title, params) => {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: params.childMaxTokens * CHARS_PER_TOKEN,
    chunkOverlap: params.childOverlapTokens * CHARS_PER_TOKEN,
    separators: ["\n\n", "\n", ". ", "; ", ", ", " ", ""],
  });

  // A figure with no description yet (or one the vision step skipped) has nothing to chunk.
  const usable = blocks.filter((b) => b.type !== "figure" || b.text);
  const sections = assignSectionPaths(explodeOversizedTables(usable, params.procedureMaxTokens), title);
  const parentGroups = buildParents(sections, params);

  const parents = [];
  const children = [];
  let chunkIndex = 0;

  for (const group of parentGroups) {
    const bodyBlocks = group.blocks;
    const { pageFrom, pageTo } = pageSpan(bodyBlocks);
    const sectionPaths = [...new Set(bodyBlocks.map((b) => b.sectionPath))];
    const parentPath = sectionPaths[0];

    const parentKey = `p${parents.length}`;
    const parentText = `${title} › ${parentPath}\n\n${bodyBlocks.map(renderBlock).join("\n\n")}`;

    parents.push({
      key: parentKey,
      chunkIndex: chunkIndex++,
      sectionPath: parentPath,
      pageFrom,
      pageTo,
      text: parentText,
      metadata: { kind: "parent", chunker: CHUNKER_VERSION, sections: sectionPaths },
    });

    for (const piece of await buildChildPieces(bodyBlocks, params, splitter)) {
      const span = pageSpan(piece.blocks);
      // Each child is embedded and keyword-indexed WITH its location: manual
      // sections often never repeat the product name, and this header is what
      // lets "5550 flash pattern" find them.
      const childPath = piece.blocks[0].sectionPath;
      const text = `${title} › ${childPath}\n${piece.body}`;

      children.push({
        parentKey,
        chunkIndex: chunkIndex++,
        sectionPath: childPath,
        pageFrom: span.pageFrom,
        pageTo: span.pageTo,
        text,
        metadata: {
          kind: piece.kind,
          chunker: CHUNKER_VERSION,
          ...(piece.hasWarning && { hasWarning: true }),
          ...(piece.stepCount && { stepCount: piece.stepCount }),
          ...(piece.part && { part: piece.part }),
          ...(piece.kind === "figure" && { machineGenerated: true, visualType: piece.visualType }),
        },
      });
    }
  }

  return { parents, children };
};
