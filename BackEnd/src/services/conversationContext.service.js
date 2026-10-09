import { getOpenAIClient } from "../config/openaiClient.js";
import { logger } from "../utils/logger.js";

// The conversation "context window": the last few turns travel with each question,
// so a follow-up ("and the wiring?", "what about the second step?") is understood
// and the answer stays related to what was just discussed.
//
// Two uses of the history:
//   1. Retrieval. Search needs a self-contained question, so a follow-up is first
//      rewritten into one (contextualizeQuestion). A question that already stands
//      on its own skips the rewrite — no extra AI call, no added delay.
//   2. Generation. The same turns are shown to the answer model as context only
//      (historyBlock); every fact must still come from the retrieved evidence.

const REWRITE_MODEL = process.env.OPENAI_REWRITE_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
const REWRITE_TIMEOUT_MS = parseInt(process.env.REWRITE_TIMEOUT_MS || "6000", 10);

const MAX_TURN_CHARS = { technician: 500, agent: 900 };
// Hard cap on what the history may add to a prompt, however many turns are allowed.
const MAX_HISTORY_CHARS = 4000;

const ROLE_LABEL = { technician: "Technician", agent: "Assistant" };

/** Validates what the client sent: the last `maxTurns` turns, trimmed, newest kept, within the character budget. */
export const sanitizeHistory = (raw, maxTurns = 6) => {
  if (!Array.isArray(raw) || maxTurns <= 0) return [];
  const turns = raw
    .filter((t) => t && (t.role === "technician" || t.role === "agent") && typeof t.text === "string" && t.text.trim())
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, MAX_TURN_CHARS[t.role]) }))
    .slice(-maxTurns);

  // Drop the oldest turns until the whole thing fits.
  let total = turns.reduce((sum, t) => sum + t.text.length, 0);
  while (turns.length > 0 && total > MAX_HISTORY_CHARS) total -= turns.shift().text.length;
  return turns;
};

// Words that lean on an earlier turn: "and the wiring?", "what about that one", "why?".
const FOLLOW_UP_START = /^(and|also|so|then|but|ok|okay|what about|how about|what if|why|where|which|can you|could you|is it|does it|do they|are they|what else)\b/i;
const REFERS_BACK = /\b(it|its|that|this|those|these|them|they|the same|that one|this one|the other|previous|earlier|above|again|instead)\b/i;

/** Cheap check for "this question cannot be searched on its own", so most questions skip the rewrite. */
export const looksLikeFollowUp = (question) => {
  const q = question.trim();
  const words = q.split(/\s+/).length;
  return words <= 6 || FOLLOW_UP_START.test(q) || REFERS_BACK.test(q);
};

/** The history as plain text for a prompt. Empty string when there is none. */
export const historyBlock = (history) =>
  history && history.length > 0 ? history.map((t) => `${ROLE_LABEL[t.role]}: ${t.text}`).join("\n") : "";

const REWRITE_PROMPT = `You rewrite a technician's latest message into one self-contained search question, using the conversation for context.

Rules:
- Resolve references ("it", "that one", "the second step", "and the wiring?") to the specific product, guide or topic they mean.
- Keep every product name, model or part code, wire colour and number exactly as written.
- If the latest message already stands on its own, return it unchanged.
- If it is a new topic unrelated to the conversation, return it unchanged.
- Do not answer the question. Do not add facts that are not in the conversation. Output only the question, on one line.`;

/**
 * The question to retrieve with. Returns `question` unchanged when there is no
 * history, when it already stands alone, or if the rewrite fails or is too slow
 * (then the last technician question is appended, so retrieval still has the topic).
 */
export const contextualizeQuestion = async ({ question, history }) => {
  if (!history || history.length === 0 || !looksLikeFollowUp(question)) return question;

  const lastAsked = [...history].reverse().find((t) => t.role === "technician")?.text;
  const fallback = lastAsked && !question.includes(lastAsked) ? `${lastAsked} ${question}` : question;

  try {
    const response = await getOpenAIClient().chat.completions.create(
      {
        model: REWRITE_MODEL,
        messages: [
          { role: "system", content: REWRITE_PROMPT },
          { role: "user", content: `Conversation so far:\n${historyBlock(history)}\n\nLatest message: ${question}` },
        ],
      },
      { signal: AbortSignal.timeout(REWRITE_TIMEOUT_MS) }
    );
    const rewritten = response.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, "");
    // A rewrite that is empty, an essay, or blown up is not trusted.
    if (!rewritten || rewritten.length > 400 || rewritten.includes("\n")) return fallback;
    if (rewritten !== question) logger.info(`[context] follow-up rewritten: "${question}" -> "${rewritten}"`);
    return rewritten;
  } catch (err) {
    logger.warn(`[context] rewrite failed (${err.message}); using the last question as context`);
    return fallback;
  }
};
