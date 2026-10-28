import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFParse } from "pdf-parse";
import { getOpenAIClient } from "../../config/openaiClient.js";
import { logger } from "../../utils/logger.js";

// What the importer does with a downloaded photo or guide before it is stored:
// a preview the chat can show quickly on a phone, a thumbnail, the PDF's own
// text, and ONE reading of the picture by the OCR model. The reading is done
// here, at import, never while a technician waits: it takes 10-20 seconds per
// picture, and doing it once means every answer shows the same, reviewable text.

const PREVIEW_MAX_SIDE = 1600;
const THUMB_MAX_SIDE = 320;
const PDF_TEXT_MAX_CHARS = 20_000;
// A PDF with at least this much real text is read from its text layer, not by OCR.
const PDF_TEXT_MIN_CHARS = 40;

const OCR_MODEL = process.env.OPENAI_WIRING_OCR_MODEL || "gpt-5";
const OCR_REASONING_EFFORT = process.env.OPENAI_WIRING_OCR_REASONING || "low";
const OCR_TIMEOUT_MS = parseInt(process.env.DRIG_WIRING_OCR_TIMEOUT_MS || "120000", 10);
const OCR_TEXT_MAX_CHARS = 2000;

export const ocrModelTag = () => OCR_MODEL;

const resized = async (image, maxSide) => {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // JPEG has no transparency: a transparent PNG would otherwise turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.encode("jpeg", 85);
};

/**
 * @returns {Promise<{ preview: Buffer|null, thumb: Buffer|null, width: number|null, height: number|null }>}
 *   null previews when the picture cannot be decoded: the original is still stored and shown.
 */
export const prepareImage = async (buffer) => {
  try {
    const image = await loadImage(buffer);
    return { preview: await resized(image, PREVIEW_MAX_SIDE), thumb: await resized(image, THUMB_MAX_SIDE), width: image.width, height: image.height };
  } catch (err) {
    logger.warn(`[drig wiring] could not decode an image for its preview (${err.message}); storing the original only`);
    return { preview: null, thumb: null, width: null, height: null };
  }
};

/** Page 1 as the preview, plus the PDF's own text (Google Docs exports keep it). */
export const preparePdf = async (buffer) => {
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText().catch(() => null);
    const text = (textResult?.text ?? "")
      .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, "") // pdf-parse's own page separators, not document text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    let preview = null;
    let thumb = null;
    let width = null;
    let height = null;
    try {
      const shot = await parser.getScreenshot({ partial: [1], scale: 1.5, imageBuffer: true, imageDataUrl: false });
      const page = shot.pages?.[0];
      if (page?.data) ({ preview, thumb, width, height } = await prepareImage(Buffer.from(page.data)));
    } catch (err) {
      logger.warn(`[drig wiring] could not render page 1 of a PDF (${err.message})`);
    }
    return {
      preview,
      thumb,
      width,
      height,
      pageCount: textResult?.total ?? null,
      textLayer: text ? text.slice(0, PDF_TEXT_MAX_CHARS) : null,
      hasUsableText: text.replace(/\s+/g, "").length >= PDF_TEXT_MIN_CHARS,
    };
  } finally {
    await parser.destroy();
  }
};

const OCR_PROMPT = `You transcribe vehicle wiring reference photos for installation technicians.

The image is a photo, screenshot or diagram from a vehicle wiring guide. It usually shows one or more wires or connectors with printed labels: wire colours, polarity (+/-), connector colour and pin count, pin numbers, fuse ratings, and where the connection is (a module, fuse box, ignition switch harness...).

Transcribe ONLY what is printed or written in the image, exactly as it appears. Rules:
- Never guess, infer or complete text you cannot read. Never add wiring knowledge of your own.
- Never decide which wire is the 12V constant or the ignition wire. If the image shows several wires, transcribe every one, one per line, in reading order.
- Keep the image's own wording and abbreviations ("BLK/WHT", "(+)", "pin 4", "30A").
- Arrows, circles or highlights pointing at a wire: mention them in "notes" (e.g. "red arrow points at the white wire").
- Ignore watermarks, website logos and copyright lines.

Return JSON only:
{
  "legible": true|false,          // false if the image has no readable wiring text
  "text": "<every wiring line, verbatim, one per line>",
  "wires": [ { "label": "<function label as printed, or null>", "colour": "<or null>", "polarity": "<or null>", "location": "<or null>", "connector": "<or null>", "pin": "<or null>" } ],
  "notes": "<arrows/highlights, or null>",
  "confidence": "high"|"medium"|"low"   // how sure you are every character above is right
}`;

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : null);

const cleanOcr = (parsed) => {
  const wires = Array.isArray(parsed?.wires)
    ? parsed.wires.slice(0, 20).map((w) => ({
        label: clip(w?.label, 120),
        colour: clip(w?.colour, 80),
        polarity: clip(w?.polarity, 20),
        location: clip(w?.location, 200),
        connector: clip(w?.connector, 120),
        pin: clip(w?.pin == null ? null : String(w.pin), 20),
      }))
    : [];
  const confidence = ["high", "medium", "low"].includes(parsed?.confidence) ? parsed.confidence : "low";
  const text = clip(parsed?.text, OCR_TEXT_MAX_CHARS) || null;
  return { legible: parsed?.legible === true && Boolean(text), text, wires, notes: clip(parsed?.notes, 400) || null, confidence };
};

/**
 * One OCR reading of a preview JPEG.
 * @returns {Promise<{ status: "done"|"no_text", text: string|null, json: object }>}  throws on an API failure (the caller records it)
 */
export const ocrWiringImage = async (jpeg, { label } = {}) => {
  const response = await getOpenAIClient().chat.completions.create(
    {
      model: OCR_MODEL,
      reasoning_effort: OCR_REASONING_EFFORT,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: OCR_PROMPT },
        {
          role: "user",
          content: [
            // The sheet's own label for the cell ("CSX 12V") is context, not something to copy into the transcription.
            ...(label ? [{ type: "text", text: `The wiring guide links this image from a cell labelled: ${String(label).slice(0, 120)}` }] : []),
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}`, detail: "high" } },
          ],
        },
      ],
    },
    // The SDK's own per-attempt timeout (an AbortSignal let a stalled upload hang far past it), one retry.
    { timeout: OCR_TIMEOUT_MS, maxRetries: 1 }
  );

  let parsed;
  try {
    parsed = JSON.parse(response.choices?.[0]?.message?.content ?? "{}");
  } catch {
    throw new Error("the OCR model did not return valid JSON");
  }
  const result = cleanOcr(parsed);
  return { status: result.legible ? "done" : "no_text", text: result.legible ? result.text : null, json: result };
};
