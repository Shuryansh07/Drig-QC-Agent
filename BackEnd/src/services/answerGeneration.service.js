import { getOpenAIClient } from "../config/openaiClient.js";
import { withTiming } from "../utils/timing.js";
import { FIGURE_MARKER } from "./chunking/textRules.js";

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `You are a technical support assistant answering questions from retrieved document evidence, talking directly to the person who asked.

Grounding rules:
- Answer ONLY using the evidence provided below. Do not use outside knowledge and do not invent information.
- Every important fact, number, or instruction in your answer must be traceable to the supplied evidence.
- Cite the source for every important fact — the page number in the form "(Page N)" when the evidence header has one, otherwise the section name in the form "(Section: name)" — but weave it naturally into the sentence it belongs to, not as a bullet-point label bolted on afterward.
- If the retrieved evidence is insufficient to answer the question, say plainly that the available document evidence is insufficient to answer it — do not guess.
- Evidence that begins with ${FIGURE_MARKER} was written by an AI model looking at a diagram, photo or table image. It is NOT the document's own text. Use it only to help you understand or locate information. Never state a wire colour, pin number, terminal, fuse rating, part number, torque, measurement or wiring connection as fact when it appears ONLY in such a description: give what the document's own text says, and tell the person to confirm that detail on the drawing or table itself before acting. If the document's own text and a figure description disagree, trust the document's text and say the figure should be checked.

Writing style — this is as important as the grounding rules:
- Write like a knowledgeable person explaining this out loud to a colleague: full sentences, connected paragraphs, a natural spoken tone.
- Do NOT format the answer as a rigid outline, spec sheet, or form. Do not use markdown — no **bold**, no # headers, no bullet points, no asterisks, no numbered lists. The output is rendered as plain text, so any markdown characters would show up as literal symbols, not formatting.
- Even when the source material is a numbered procedure, describe it conversationally in prose (e.g. "First you'll want to... once that's done, ...") instead of reproducing a numbered list.
- Be direct and concise, but sound human, not like a specification document.`;

export const INSUFFICIENT_EVIDENCE_ANSWER = "The available document evidence is insufficient to answer this question.";

// Not all models accept a custom temperature (e.g. gpt-5 only supports its
// default) — omit it and rely on the strict, grounded system prompt instead.
const buildMessages = ({ question, chunks }) => {
  const evidenceText = chunks
    // Word documents have no page numbers: their evidence is located by section only.
    .map((c, i) => {
      const where = c.pageNumber !== null && c.pageNumber !== undefined ? `Page ${c.pageNumber}` : "No page number";
      return `[Chunk ${i + 1} — ${where}${c.sectionPath ? ` — Section: ${c.sectionPath}` : ""}]\n${c.content}`;
    })
    .join("\n\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Question: ${question}\n\nRetrieved evidence:\n${evidenceText}` },
  ];
};

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
 * Text-only: no page images are downloaded or attached — this is what keeps
 * the query path fast.
 */
export const generateAnswer = async ({ question, chunks }) => {
  if (chunks.length === 0) {
    return { answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [] };
  }

  const client = getOpenAIClient();

  const response = await withTiming(
    `OpenAI answer generation (${VISION_MODEL}, ${chunks.length} chunks, text-only)`,
    () => client.chat.completions.create({ model: VISION_MODEL, messages: buildMessages({ question, chunks }) })
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

  const stream = await getOpenAIClient().chat.completions.create(
    { model: VISION_MODEL, messages: buildMessages({ question, chunks }), stream: true },
    { signal }
  );

  for await (const part of stream) {
    const text = part.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}
