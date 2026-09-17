import { getOpenAIClient } from "../config/openaiClient.js";
import { withTiming } from "../utils/timing.js";

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `You are a technical support assistant answering questions from retrieved document evidence, talking directly to the person who asked.

Grounding rules:
- Answer ONLY using the evidence provided below. Do not use outside knowledge and do not invent information.
- Every important fact, number, or instruction in your answer must be traceable to the supplied evidence.
- Cite the page number for every important fact, in the form "(Page N)" — but weave it naturally into the sentence it belongs to, not as a bullet-point label bolted on afterward.
- If the retrieved evidence is insufficient to answer the question, say plainly that the available document evidence is insufficient to answer it — do not guess.

Writing style — this is as important as the grounding rules:
- Write like a knowledgeable person explaining this out loud to a colleague: full sentences, connected paragraphs, a natural spoken tone.
- Do NOT format the answer as a rigid outline, spec sheet, or form. Do not use markdown — no **bold**, no # headers, no bullet points, no asterisks, no numbered lists. The output is rendered as plain text, so any markdown characters would show up as literal symbols, not formatting.
- Even when the source material is a numbered procedure, describe it conversationally in prose (e.g. "First you'll want to... once that's done, ...") instead of reproducing a numbered list.
- Be direct and concise, but sound human, not like a specification document.`;

/**
 * Text-only: no page images are downloaded or attached. Any visual content
 * on a page was already described in words by the Vision LLM at ingestion
 * time and is part of the chunk text itself, so there's nothing left to
 * re-attach here — this is what keeps the query path fast.
 */
export const generateAnswer = async ({ question, chunks }) => {
  if (chunks.length === 0) {
    return {
      answer: "The available document evidence is insufficient to answer this question.",
      sources: [],
    };
  }

  const evidenceText = chunks
    .map((c, i) => `[Chunk ${i + 1} — Page ${c.pageNumber}]\n${c.content}`)
    .join("\n\n");

  const client = getOpenAIClient();

  const response = await withTiming(
    `OpenAI answer generation (${VISION_MODEL}, ${chunks.length} chunks, text-only)`,
    () =>
      client.chat.completions.create({
        model: VISION_MODEL,
        // Not all models accept a custom temperature (e.g. gpt-5 only
        // supports its default) — omit it and rely on the strict, grounded
        // system prompt instead.
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Question: ${question}\n\nRetrieved evidence:\n${evidenceText}` },
        ],
      })
  );

  const answer =
    response.choices?.[0]?.message?.content?.trim() ||
    "The available document evidence is insufficient to answer this question.";

  const sources = Array.from(
    new Map(
      chunks.map((c) => [
        `${c.documentId}:${c.pageNumber}`,
        { document_id: c.documentId, page_number: c.pageNumber },
      ])
    ).values()
  );

  return { answer, sources };
};
