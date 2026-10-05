import { getOpenAIClient } from "../config/openaiClient.js";
import { withTiming } from "../utils/timing.js";
import { FIGURE_MARKER } from "./chunking/textRules.js";
import { toVisionImages, visionContentParts } from "./chunking/imageTiles.js";
import { findFigureImages } from "../db/images.js";
import * as storage from "./storage.service.js";
import { logger } from "../utils/logger.js";

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
// Used instead of VISION_MODEL only when a drawing is attached: reading wire labels
// off a schematic is where the small model fails.
const ANSWER_IMAGE_MODEL = process.env.OPENAI_ANSWER_IMAGE_MODEL || "gpt-4.1";
// At most this many pictures are attached to one answer (each is sent whole plus four zoomed sections).
const ANSWER_MAX_FIGURE_IMAGES = parseInt(process.env.ANSWER_MAX_FIGURE_IMAGES || "2", 10);
// Only the best-ranked evidence brings its pictures along; lower-ranked hits are rarely what the question is about.
const ANSWER_FIGURE_FROM_TOP_CHUNKS = parseInt(process.env.ANSWER_FIGURE_FROM_TOP_CHUNKS || "3", 10);

const SYSTEM_PROMPT = `You are a technical support assistant answering questions from retrieved document evidence, talking directly to the person who asked.

Grounding rules:
- Answer ONLY using the evidence provided below. Do not use outside knowledge and do not invent information.
- Every important fact, number, or instruction in your answer must be traceable to the supplied evidence.
- Cite the source for every important fact — the page number in the form "(Page N)" when the evidence header has one, otherwise the section name in the form "(Section: name)" — but weave it naturally into the sentence it belongs to, not as a bullet-point label bolted on afterward.
- If the retrieved evidence is insufficient to answer the question, say plainly that the available document evidence is insufficient to answer it — do not guess.
- Some evidence pages may be attached as images. Each attached page comes as the whole page first, then overlapping zoomed sections of the SAME page for reading small print: never count a component twice because it appears in both. These images are the document itself, so they are evidence just like the text — read wire colours, gauges, pins, labels, counts and title-block details directly from them.
- Evidence that begins with ${FIGURE_MARKER} was written by an AI model looking at a diagram, photo or table image. It is a guide, not the document's own text, and it can be wrong. It was written from a more zoomed-in view than you get, so it is often right about very small labels. When the same page is attached as an image, check the description against the image; where they disagree on a detail, give both readings and tell the person to confirm on the drawing.
- When you state a wire colour, gauge, pin, terminal, fuse rating, part number, measurement or wiring connection that you read from a drawing or table (image or description), say so in the sentence (for example "according to the wiring drawing on Page 1") so the technician knows to check it against the drawing before acting. If the document's own text and a drawing disagree, say so and give both.
- If a detail is genuinely not legible in the image, say which part you could not read instead of guessing.

Writing style — this is as important as the grounding rules:
- Write like a knowledgeable person explaining this out loud to a colleague: full sentences, connected paragraphs, a natural spoken tone.
- Do NOT format the answer as a rigid outline, spec sheet, or form. Do not use markdown — no **bold**, no # headers, no bullet points, no asterisks, no numbered lists. The output is rendered as plain text, so any markdown characters would show up as literal symbols, not formatting.
- Even when the source material is a numbered procedure, describe it conversationally in prose (e.g. "First you'll want to... once that's done, ...") instead of reproducing a numbered list.
- Be direct and concise, but sound human, not like a specification document.`;

export const INSUFFICIENT_EVIDENCE_ANSWER = "The available document evidence is insufficient to answer this question.";

// Not all models accept a custom temperature (e.g. gpt-5 only supports its
// default) — omit it and rely on the strict, grounded system prompt instead.
export const buildMessages = ({ question, chunks, images = [] }) => {
  const evidenceText = chunks
    // Word documents have no page numbers: their evidence is located by section only.
    .map((c, i) => {
      const where = c.pageNumber !== null && c.pageNumber !== undefined ? `Page ${c.pageNumber}` : "No page number";
      return `[Chunk ${i + 1} — ${where}${c.sectionPath ? ` — Section: ${c.sectionPath}` : ""}]\n${c.content}`;
    })
    .join("\n\n");

  const text = `Question: ${question}\n\nRetrieved evidence:\n${evidenceText}`;
  if (images.length === 0) {
    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ];
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `${text}\n\nAttached pages from the evidence above:` },
        ...images.flatMap((figure) => [{ type: "text", text: `=== ${figure.label} ===` }, ...visionContentParts(figure.parts)]),
      ],
    },
  ];
};

/**
 * The pictures behind the best-ranked evidence, ready to attach: a figure chunk
 * brings the exact picture it describes; any other chunk brings the pictures on
 * its page (a wiring label scattered in a PDF's text layer is useless without the
 * drawing it sits on). Never fails the answer: a picture that cannot be loaded is
 * skipped and the answer is written from text alone.
 */
const loadEvidenceImages = async (chunks) => {
  if (ANSWER_MAX_FIGURE_IMAGES <= 0) return [];

  const refs = chunks
    .slice(0, ANSWER_FIGURE_FROM_TOP_CHUNKS)
    .filter((c) => c.imageHash || (c.pageNumber !== null && c.pageNumber !== undefined))
    .map((c) => ({ docId: c.documentId, contentHash: c.imageHash ?? null, page: c.imageHash ? null : c.pageNumber }));

  let found;
  try {
    // A Word file can embed EMF/WMF pictures the model cannot open; one of those would fail the whole answer.
    found = (await findFigureImages(refs)).filter((f) => ATTACHABLE.test(f.s3Key)).slice(0, ANSWER_MAX_FIGURE_IMAGES);
  } catch (err) {
    logger.error("[answer] could not look up evidence images (answering from text only)", err);
    return [];
  }

  const titleOf = new Map(chunks.map((c) => [c.documentId, c.documentTitle]));
  const loaded = await Promise.all(
    found.map(async (figure) => {
      try {
        const buffer = await storage.getBuffer(figure.s3Key);
        const mimeType = figure.s3Key.endsWith(".jpg") ? "image/jpeg" : `image/${figure.s3Key.split(".").pop()}`;
        const where = figure.page !== null ? `page ${figure.page}` : "embedded image";
        return { label: `${titleOf.get(figure.docId) ?? "Document"}, ${where}`, parts: await toVisionImages(buffer, mimeType) };
      } catch (err) {
        logger.error(`[answer] could not load evidence image ${figure.s3Key} (skipped)`, err);
        return null;
      }
    })
  );
  return loaded.filter(Boolean);
};

const ATTACHABLE = /\.(png|jpg|jpeg|webp|gif)$/i;

const modelFor = (images) => (images.length > 0 ? ANSWER_IMAGE_MODEL : VISION_MODEL);

/**
 * One entry per distinct place in a document the evidence came from: a page
 * for a PDF, a section for a Word file (which has no pages, so page_number is null).
 */
export const sourcesFromChunks = (chunks) =>
  Array.from(
    new Map(
      chunks.map((c) => [
        `${c.documentId}:${c.pageNumber ?? c.sectionPath ?? ""}`,
        {
          document_id: c.documentId,
          document_title: c.documentTitle ?? null,
          page_number: c.pageNumber ?? null,
          section_path: c.sectionPath ?? null,
        },
      ])
    ).values()
  );

/**
 * Text-only unless the best evidence sits on a drawing, photo or table: then that
 * picture is attached so the model reads it directly instead of trusting a
 * description of it. Text-only questions stay on the fast path.
 */
export const generateAnswer = async ({ question, chunks }) => {
  if (chunks.length === 0) {
    return { answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [] };
  }

  const client = getOpenAIClient();
  const images = await withTiming("load evidence images", () => loadEvidenceImages(chunks));
  const model = modelFor(images);

  const response = await withTiming(
    `OpenAI answer generation (${model}, ${chunks.length} chunks, ${images.length} image(s))`,
    () => client.chat.completions.create({ model, messages: buildMessages({ question, chunks, images }) })
  );

  const answer = response.choices?.[0]?.message?.content?.trim() || INSUFFICIENT_EVIDENCE_ANSWER;

  return { answer, sources: sourcesFromChunks(chunks) };
};

/**
 * Same grounding as generateAnswer, but yields the answer text as the model
 * writes it. `signal` aborts the upstream request when the client disconnects,
 * so a technician who closes the app stops costing tokens.
 *
 * Callers must have passed the retrieval gate first: with no chunks there is
 * nothing to ground on, and this refuses rather than letting the model improvise.
 */
export async function* streamAnswer({ question, chunks, signal }) {
  if (chunks.length === 0) throw new Error("streamAnswer called with no evidence — the retrieval gate should have refused first");

  const images = await withTiming("load evidence images", () => loadEvidenceImages(chunks));
  if (images.length > 0) logger.info(`[answer] attaching ${images.length} evidence image(s): ${images.map((i) => i.label).join("; ")}`);

  const stream = await getOpenAIClient().chat.completions.create(
    { model: modelFor(images), messages: buildMessages({ question, chunks, images }), stream: true },
    { signal }
  );

  for await (const part of stream) {
    const text = part.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}
