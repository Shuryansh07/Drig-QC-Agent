import { getOpenAIClient } from "../config/openaiClient.js";
import { withTiming } from "../utils/timing.js";
import { logger } from "../utils/logger.js";
import { buildMessages, loadEvidenceImages, modelFor } from "./answerGeneration.service.js";

/**
 * Runs after an answer has already been written, before it reaches the technician
 * (Blueprint §6, Checks 5–7). Three things, in increasing cost:
 *
 *   Check 5 — is every citation real? Deterministic, no AI, runs first: if the
 *   answer cites a page or section that was never retrieved, that alone is
 *   disqualifying and the (paid) model check below is skipped entirely.
 *
 *   Check 6 — do the specific details match the evidence exactly? A wire colour,
 *   pin number, fuse rating or torque value that doesn't appear in the cited
 *   evidence is the "right-looking paragraph with one wrong number" the Blueprint
 *   calls the most dangerous failure mode in this domain.
 *
 *   Check 7 — was a warning, disconnect or isolation step dropped? Text can be
 *   100% accurate and still send a technician onto a live circuit if the one
 *   safety-relevant line from the source never made it into the answer.
 *
 * Checks 6 and 7 are judgment calls, so they share one model call rather than two
 * — same evidence, same read, half the latency and cost of asking twice.
 *
 * Looks at the same evidence images the primary answer used (not just their
 * already-ingested text description) — the caller resolves them once, right
 * after retrieval, and passes the same `images` in here and into generation,
 * so they're never fetched from S3 twice. Tried text-only first for speed — it
 * cut this step from ~8.9s to ~1.9s — but on repeated live runs its stated
 * reasons for a retraction were sometimes wrong even when the retraction
 * itself was still the right call (e.g. once claimed a warning was missing
 * that was, in fact, in the text, just paraphrased). Chosen back in favour of
 * accuracy: this check exists specifically to catch the detail an LLM got
 * subtly wrong, so it should look at the same picture the answer was
 * supposedly reading from, not a second model's earlier written description
 * of it. `images` is still optional here (falls back to loading them) for any
 * caller — a test, a retry path — that only has `chunks` on hand.
 *
 * Fails CLOSED: if the verification call itself errors (bad JSON, the API down,
 * no credits), that counts as a failure, not a pass. An answer that could not be
 * checked is treated the same as one that failed the check — never shipped on
 * the assumption it was probably fine.
 */

const PAGE_CITATION_RE = /\(Page\s+(\d+)\)/gi;
const SECTION_CITATION_RE = /\(Section:\s*([^)]+)\)/gi;

/** Check 5. Synchronous, free — every retrieved chunk's real location vs. what the answer actually cited. */
export const validateCitations = ({ answer, chunks }) => {
  const validPages = new Set(chunks.map((c) => c.pageNumber).filter((p) => p !== null && p !== undefined));
  const validSections = new Set(
    chunks.map((c) => c.sectionPath).filter(Boolean).map((s) => s.trim().toLowerCase())
  );

  const violations = [];

  for (const match of answer.matchAll(PAGE_CITATION_RE)) {
    const page = parseInt(match[1], 10);
    if (!validPages.has(page)) {
      violations.push({
        type: "unverified_citation",
        description: `Answer cites Page ${page}, which is not among the retrieved evidence.`,
      });
    }
  }

  for (const match of answer.matchAll(SECTION_CITATION_RE)) {
    const section = match[1].trim();
    if (!validSections.has(section.toLowerCase())) {
      violations.push({
        type: "unverified_citation",
        description: `Answer cites "Section: ${section}", which is not among the retrieved evidence.`,
      });
    }
  }

  return violations;
};

const VERIFY_SYSTEM_PROMPT = `You are auditing a technical answer against the evidence it was supposedly generated from. You are NOT writing an answer — a separate step already wrote it. Your only job is to check it.

Check two things, independently:

1. DETAIL ACCURACY — every wire colour, pin/terminal number, fuse rating, torque value, voltage, or other specific measurement stated in the answer must appear, with the same value, in the evidence below (including any attached images). Flag anything stated that you cannot verify against the evidence, or that contradicts it.

2. SAFETY PRESERVATION — if the evidence contains a warning, caution, disconnect instruction, or isolation step relevant to what the answer describes, its substance must appear in the answer. Flag any such warning, disconnect, or isolation step that is present in the evidence but missing from the answer.

Do not flag paraphrasing, style, or an omitted detail that is neither a specific measurement nor safety-relevant. Only flag a real mismatch or a real missing safety step.

Respond with ONLY a JSON object, no other text:
{"passed": boolean, "violations": [{"type": "detail_mismatch" | "dropped_warning", "description": "one sentence"}]}
"passed" must be true only when "violations" is empty.`;

/** Same evidence formatting generateAnswer() used, system prompt swapped for the auditor's, with the answer appended to check. */
const buildVerificationMessages = ({ question, answer, chunks, images }) => {
  const [, userMessage] = buildMessages({ question, chunks, images });
  const appended = `\n\nAnswer to verify:\n"""\n${answer}\n"""`;

  const content = Array.isArray(userMessage.content)
    ? [...userMessage.content, { type: "text", text: appended }]
    : `${userMessage.content}${appended}`;

  return [
    { role: "system", content: VERIFY_SYSTEM_PROMPT },
    { role: "user", content },
  ];
};

/** Checks 6+7, combined into one model call. */
const verifyDetailsAndWarnings = async ({ question, answer, chunks, images }) => {
  const evidenceImages = images ?? (await loadEvidenceImages(chunks));
  const model = modelFor(evidenceImages);
  const messages = buildVerificationMessages({ question, answer, chunks, images: evidenceImages });

  const response = await withTiming(`OpenAI answer verification (${model})`, () =>
    getOpenAIClient().chat.completions.create({ model, messages, response_format: { type: "json_object" } })
  );

  const raw = response.choices?.[0]?.message?.content;
  const parsed = JSON.parse(raw); // malformed JSON is caught by the caller and treated as a failed check
  return Array.isArray(parsed.violations) ? parsed.violations : [];
};

/**
 * @returns {Promise<{passed: boolean, violations: {type: string, description: string}[]}>}
 */
export const verifyAnswer = async ({ question, answer, chunks, images }) => {
  const citationViolations = validateCitations({ answer, chunks });
  if (citationViolations.length > 0) {
    logger.warn(`[verify] citation check failed: ${citationViolations.map((v) => v.description).join(" | ")}`);
    return { passed: false, violations: citationViolations };
  }

  try {
    const modelViolations = await verifyDetailsAndWarnings({ question, answer, chunks, images });
    if (modelViolations.length > 0) {
      logger.warn(`[verify] detail/warning check failed: ${modelViolations.map((v) => v.description).join(" | ")}`);
    }
    return { passed: modelViolations.length === 0, violations: modelViolations };
  } catch (err) {
    logger.error("[verify] verification call itself failed — treating the answer as unverified, not as passed", err);
    return { passed: false, violations: [{ type: "verification_unavailable", description: "The verification check could not run." }] };
  }
};
