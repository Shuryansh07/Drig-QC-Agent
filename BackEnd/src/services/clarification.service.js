import { containsExactCode } from "./ragRetrieval.service.js";

// Blueprint Check 1 — "did we understand the question?". The system asks only
// when the answer genuinely depends on the missing detail, and asks about
// something real: the options are the guides retrieval actually found, not a
// generic prompt. No extra AI call: it reads what the search already returned.
//
// The test: if several different documents match the question about equally
// well, and the question gives nothing that tells them apart, the answer would
// differ depending on which one is meant, so ask. If the question already points
// at one of them (it uses a word only that title has), or names an exact
// model/part code, just answer.

// Words that appear in nearly every manual title and so never tell two apart.
const GENERIC_TITLE_WORDS = new Set([
  "guide", "guides", "install", "installation", "installer", "manual", "manuals", "instructions", "instruction",
  "user", "quick", "start", "quickstart", "reference", "card", "document", "doc", "pdf", "docx", "copy", "the",
  "and", "for", "with", "how", "setup", "set", "up", "new", "old", "version", "rev", "app",
]);

const tokensOf = (text) => (String(text ?? "").toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter((t) => t.length >= 3);

const distinguishingTokens = (title) => new Set(tokensOf(title).filter((t) => !GENERIC_TITLE_WORDS.has(t)));

/** "Copy of Wahoo Installation Guide(2).pdf" -> "Wahoo Installation Guide". */
export const cleanTitle = (title) =>
  String(title ?? "")
    .replace(/\.(pdf|docx|jpe?g|png)$/i, "")
    .replace(/^copy of\s+/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();

const hintOf = (chunk) => {
  const section = chunk.sectionPath?.split(" > ").pop();
  if (section) return section;
  return chunk.pageNumber !== null && chunk.pageNumber !== undefined ? `Page ${chunk.pageNumber}` : undefined;
};

/**
 * @param {object} args
 * @param {string} args.question
 * @param {object[]} args.chunks     retrieved evidence, best first (retrieveRelevantChunks().chunks)
 * @param {object} args.admission    retrieveRelevantChunks().admission
 * @param {number} args.gap          documents this close (cosine) to the best one count as "equally good"
 * @param {number} args.minOptions   fewer equally good documents than this: nothing to ask about
 * @param {number} args.maxOptions
 * @returns {null | {slot: string, question: string, options: object[], allowSkip: boolean}}
 */
export const decideClarification = ({ question, chunks, admission, gap = 0.05, minOptions = 2, maxOptions = 4 }) => {
  // A model or part code is specific already: the code names the product.
  if (admission?.reason === "exact_code" || containsExactCode(question)) return null;
  if (!chunks || chunks.length < minOptions) return null;

  // The best chunk of each distinct document title.
  const byTitle = new Map();
  for (const chunk of chunks) {
    const title = cleanTitle(chunk.documentTitle);
    if (!title) continue;
    const best = byTitle.get(title);
    if (!best || (chunk.similarity ?? 0) > (best.similarity ?? 0)) byTitle.set(title, chunk);
  }

  const ranked = [...byTitle.entries()].sort(([, a], [, b]) => (b.similarity ?? 0) - (a.similarity ?? 0));
  if (ranked.length < minOptions) return null;

  const top = ranked[0][1].similarity ?? 0;
  const near = ranked.filter(([, chunk]) => top - (chunk.similarity ?? 0) <= gap).slice(0, maxOptions);
  if (near.length < minOptions) return null;

  // Does the question already single some of them out? A word only some of these titles carry.
  const questionTokens = new Set(tokensOf(question));
  const tokenSets = near.map(([title]) => distinguishingTokens(title));
  const inEvery = [...tokenSets[0]].filter((t) => tokenSets.every((set) => set.has(t)));
  const singledOut = tokenSets.some((set) => [...set].some((t) => !inEvery.includes(t) && questionTokens.has(t)));
  if (singledOut) return null;

  return {
    slot: "document",
    question: "I found more than one guide that could match. Which one do you mean?",
    options: near.map(([title, chunk]) => ({ value: title, label: title, hint: hintOf(chunk) })),
    allowSkip: false,
  };
};

/** The question retrieval and the answer use once the technician has picked: the original plus their pick. */
export const withClarification = (question, clarification) => {
  const value = typeof clarification?.value === "string" ? clarification.value.trim().slice(0, 200) : "";
  if (!value || clarification?.skipped === true) return question;
  return `${question.trim()} (${value})`;
};
