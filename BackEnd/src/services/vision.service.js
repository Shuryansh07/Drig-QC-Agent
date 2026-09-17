import { getOpenAIClient } from "../config/openaiClient.js";
import { withTiming } from "../utils/timing.js";
import { visionLimiter } from "../utils/concurrencyLimiter.js";
import { retryWithBackoff } from "../utils/retry.js";

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
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
