import { getOpenAIClient } from "../config/openaiClient.js";
import { withTiming } from "../utils/timing.js";
import { visionLimiter } from "../utils/concurrencyLimiter.js";
import { retryWithBackoff } from "../utils/retry.js";
import { toVisionImages, visionContentParts } from "./chunking/imageTiles.js";

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
// Diagrams are where a small model fails worst (it invents pin lists and misses
// wires), and each figure is described once per document, so the stronger model
// is worth its price here even where the cheap one does everything else.
const FIGURE_MODEL = process.env.OPENAI_FIGURE_MODEL || "gpt-4.1";
// Tiles per side for figure images (3 = whole image plus nine zoomed tiles; 1 = whole image only). Paid once per
// figure at ingestion: 3 was the first setting that read 4pt connector labels on a landscape schematic correctly.
const FIGURE_TILE_GRID = parseInt(process.env.VISION_FIGURE_TILE_GRID || "3", 10);
const VISION_TIMEOUT_MS = parseInt(process.env.VISION_TIMEOUT_MS || "90000", 10);
// A sustained per-minute rate-limit collision can outlast the OpenAI SDK's
// own (short) internal retry window — see the 43/75-page failure this was
// added for. 5 attempts at 2s/4s/8s/16s/32s (+jitter) span ~60s of waiting,
// long enough for the TPM window to actually roll over.
const VISION_MAX_RETRIES = parseInt(process.env.VISION_MAX_RETRIES || "5", 10);

const SYSTEM_PROMPT = `You are a technical document understanding assistant preparing content for a retrieval-augmented search system.

You will be given the extracted text of ONE page from a PDF manual, and a snapshot image of that same page.

Rules:
- Use ONLY the supplied page text and page image. Do not use outside knowledge and do not invent information.
- Combine the textual and visual information into a single, coherent description of what this page contains.
- Clearly distinguish what is actually visible or explicitly stated on the page — do not guess at anything unclear.
- Preserve exactly: numbers, specifications, model/part numbers, labels, measurements, units, warnings/cautions, relationships between components, table values, and diagram content (what a diagram shows, connections, flow direction).
- If the page contains a diagram, chart, table, or screenshot, describe what it shows in words so it becomes searchable as text.
- Be concise but information-rich — no filler sentences.
- Write so the output makes sense standalone, without the original page, since it may be retrieved in isolation later.
- Do NOT reference or assume information from any other page of the document.
- If the page is blank, purely decorative, or has no extractable content, say so plainly in one short sentence.

Output plain text only — no markdown headers, no preamble like "This page shows". Just the factual content.`;

/**
 * Sends one page's text + snapshot to the Vision LLM and returns the
 * processed, RAG-ready content. This output — not the raw PDF text — is
 * what gets stored in document_chunks.content.
 */
export const analyzePage = async ({ fileName, pageNumber, pageText, imageBuffer }) => {
  const client = getOpenAIClient();

  const userContent = [
    {
      type: "text",
      text:
        `Document: ${fileName}\nPage: ${pageNumber}\n\n` +
        `Extracted page text (may be incomplete or empty if this page is image-only):\n` +
        `"""\n${pageText || "(no text extracted from this page)"}\n"""`,
    },
  ];

  if (imageBuffer) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${imageBuffer.toString("base64")}` },
    });
  } else {
    userContent.push({
      type: "text",
      text: "(No page snapshot image was available for this page — rely on the extracted text only.)",
    });
  }

  // retryWithBackoff wraps visionLimiter, not the other way around — a
  // backoff wait releases the concurrency slot instead of holding it idle,
  // so other pages can use it while this one waits out a rate limit.
  const response = await retryWithBackoff(
    `Vision analyzePage (page ${pageNumber})`,
    () =>
      visionLimiter(() =>
        withTiming(`OpenAI vision analyzePage (${VISION_MODEL}, page ${pageNumber})`, () =>
          client.chat.completions.create(
            {
              model: VISION_MODEL,
              // Not all vision models accept a custom temperature (e.g. gpt-5 only
              // supports its default) — omit it and rely on the low-temperature-like
              // behavior of the strict, grounded system prompt instead.
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userContent },
              ],
            },
            { timeout: VISION_TIMEOUT_MS }
          )
        )
      ),
    { maxRetries: VISION_MAX_RETRIES, baseDelayMs: 2000 }
  );

  const content = response.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error(`Vision LLM returned empty content for page ${pageNumber}`);
  }

  return content;
};

// ---------------------------------------------------------------------------
// Figures, diagrams and tables (ingestion). Separate from analyzePage above:
// that describes a whole page; this describes only the NON-PROSE content of a
// page or image, because the prose is already extracted as text.
// ---------------------------------------------------------------------------

export const FIGURE_PROMPT_VERSION = "figure-v2";
/** Stored with every description so a change of model or prompt is a cache miss, not a stale hit. */
export const figureModelTag = () => `${FIGURE_MODEL}@${FIGURE_PROMPT_VERSION}`;

const VISUAL_TYPES = new Set(["diagram", "photo", "table", "chart", "screenshot", "mixed", "decorative", "none"]);

const FIGURE_SYSTEM_PROMPT = `You describe the visual, non-prose content of technical documents so it can be found by text search. The body text of the page is already extracted separately, so do not repeat ordinary paragraphs.

You are given the whole image first, then (for large images) overlapping zoomed sections of the same image. Use the whole image for layout and which line goes where; use the zoomed sections to read small print exactly. They are the SAME drawing: do not count anything twice because it appears in the whole image and in one or more zoomed sections.

What to cover:
- Wiring, electrical and connection diagrams. Write these sections, each starting on its own line:
  TITLE BLOCK: drawing title, drawing/part number, revision, date, sheet, customer, vehicle/chassis and body as printed.
  COMPONENTS: every lamp, connector, switch, relay, module, ground and terminal, by its printed name, with a count of how many of each are drawn (e.g. "RIGHT TURN: 2").
  WIRES: one line per wire or wire label, as "colour [gauge] — from X — to Y". Copy the colour and gauge exactly as printed (e.g. "PUR 16 GA"). If one wire feeds several components, list all of them.
  CONNECTORS: for each connector, each cavity/pin and the wire colour on it, in the order drawn. Say which pins are unused, capped or marked with an "X" and the colour of that wire. Do not invent pin numbers that are not printed; say "position 3 from left, top row" instead.
  GROUNDS: which wires go to each ground point, with colour and gauge.
  NOTES: any printed notes, warnings or callouts, verbatim.
- Other diagrams and drawings: what the diagram shows, every printed label, the components and how they are laid out.
- Photos and screenshots: what they show and any visible text.
- Charts: what is plotted, axis labels, and the values that are printed.
- Tables: transcribe EVERY row and column faithfully, one row per line, as "Column name: value; Column name: value". Do not skip rows or merge cells.

Strict rules:
- Use only what is visible. Do not use outside knowledge and do not guess.
- Copy numbers, part numbers, model numbers, wire colours, gauges, pin numbers, units (' is feet, " is inches) and warnings exactly as printed.
- Follow each line from end to end before saying where it goes. If a line's path is ambiguous (crossings, lines that run off the image), write "connection unclear" for that wire instead of guessing.
- If part of the image is unreadable, say which part is unreadable instead of guessing.
- Write plain text, no markdown. Be complete for tables, labels and wires, concise everywhere else.

Output format, exactly:
Line 1: TYPE: followed by one of diagram, photo, table, chart, screenshot, mixed, decorative, none
Line 2 onward: the description.
Use "TYPE: decorative" for logos, icons, borders and purely decorative images, and "TYPE: none" if the image has no diagram, photo, chart or table at all. For decorative or none, write nothing after line 1.`;

/** Splits "TYPE: diagram\n<description>" into its parts, tolerating a model that adds nothing or formats it loosely. */
export const parseFigureReply = (reply) => {
  const text = (reply ?? "").trim();
  const match = text.match(/^\s*TYPE:\s*([A-Za-z]+)[^\n]*\n?([\s\S]*)$/i);
  if (!match) return { visualType: "mixed", description: text };

  const visualType = VISUAL_TYPES.has(match[1].toLowerCase()) ? match[1].toLowerCase() : "mixed";
  return { visualType, description: match[2].trim() };
};

/**
 * Sends one image (a rendered PDF page, or an image from a Word file) to the
 * vision model and returns what non-prose content it contains, as text.
 *
 * @returns {{ visualType: string, description: string }} `description` is empty
 *   for decorative images and for pages with nothing to describe.
 */
export const describeVisual = async ({ imageBuffer, mimeType, fileName, locator, reasons, contextText }) => {
  const client = getOpenAIClient();

  const userContent = [
    {
      type: "text",
      text:
        `Document: ${fileName}\nWhere: ${locator}\n` +
        (reasons?.length ? `This was sent because it appears to contain: ${reasons.join(", ")}.\n` : "") +
        `\nText already extracted from this page (context only — do not repeat it):\n"""\n${(contextText || "(none)").slice(0, 4000)}\n"""`,
    },
    ...visionContentParts(await toVisionImages(imageBuffer, mimeType, { grid: FIGURE_TILE_GRID })),
  ];

  const response = await retryWithBackoff(
    `Vision describeVisual (${locator})`,
    () =>
      visionLimiter(() =>
        withTiming(`OpenAI vision describeVisual (${FIGURE_MODEL}, ${locator})`, () =>
          client.chat.completions.create(
            {
              model: FIGURE_MODEL,
              messages: [
                { role: "system", content: FIGURE_SYSTEM_PROMPT },
                { role: "user", content: userContent },
              ],
            },
            { timeout: VISION_TIMEOUT_MS }
          )
        )
      ),
    { maxRetries: VISION_MAX_RETRIES, baseDelayMs: 2000 }
  );

  const reply = response.choices?.[0]?.message?.content;
  if (!reply || !reply.trim()) throw new Error(`Vision model returned an empty reply for ${locator}`);

  const parsed = parseFigureReply(reply);
  // A description on a page marked decorative/none is noise, not content.
  if (parsed.visualType === "decorative" || parsed.visualType === "none") return { visualType: parsed.visualType, description: "" };
  return parsed;
};
