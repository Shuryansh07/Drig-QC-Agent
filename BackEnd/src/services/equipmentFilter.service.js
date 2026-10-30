import { getOpenAIClient } from "../config/openaiClient.js";
import { listEquipmentCatalog } from "../db/documents.js";
import { logger } from "../utils/logger.js";

// Equipment filter: when a question names a product ("How do I install the SIM
// in the AD Plus2.0?"), retrieval searches only the documents about that
// product. Without it, another product's guide with a near-identical procedure
// (a ZenCAM PLUS guide) can outrank the right manual, and the answer cites the
// wrong device.
//
// Two steps:
//   1. A small AI call pulls the equipment names out of the question. It sees
//      only the question, so the prompt stays tiny however many documents exist.
//   2. Each name is matched against every live document's title (and its
//      vendor / models, when set) in code, with case, spaces and punctuation
//      ignored: "AD Plus 2.0" finds "AD PLUS 2.0+POWER BOX…" and
//      "AD Plus2.0 Series Product User Manual".
// No equipment named, no document matched, a failure or a timeout: all mean
// "no filter", and retrieval searches everything as before.
//
// A chat opened from a jobsheet knows the job's equipment already. It is used
// when the question names none ("where does the SIM go?"); a question that names
// equipment of its own is about that equipment instead.

const EXTRACT_MODEL = process.env.OPENAI_EQUIPMENT_MODEL || process.env.OPENAI_REWRITE_MODEL || "gpt-4o-mini";
const EXTRACT_TIMEOUT_MS = parseInt(process.env.EQUIPMENT_EXTRACT_TIMEOUT_MS || "5000", 10);
// Short: a newly published document should be filterable within a minute.
const CATALOG_TTL_MS = 60 * 1000;
// Below this many letters/digits a name ("N4") is matched as a whole word, not
// anywhere inside a title, or it would hit unrelated titles by accident.
const MIN_SUBSTRING_LENGTH = 4;

let catalogCache = null;

/** "AD Plus 2.0" and "AD-PLUS2.0" -> "adplus20". */
const squash = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const words = (text) => String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];

const getCatalog = async () => {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.entries;
  const entries = (await listEquipmentCatalog()).map((entry) => {
    const text = [entry.title.replace(/\.(pdf|docx|jpe?g|png)$/i, ""), entry.vendor, entry.productFamily, ...entry.models]
      .filter(Boolean)
      .join(" ");
    return { docId: entry.docId, title: entry.title, squashed: squash(text), words: new Set(words(text)) };
  });
  catalogCache = { entries, expiresAt: Date.now() + CATALOG_TTL_MS };
  return entries;
};

const EXTRACT_PROMPT = `You pull equipment names out of a technician's question. Return JSON only:
{"equipment": ["<each product, model, series or part code the question names>"]}

Rules:
- Equipment is a specific product, model, series or part code: "AD Plus2.0", "5550A-VM", "ZenCAM LITE", "EC1004-SK", "Vision III".
- Keep each name exactly as written, without generic words around it ("AD Plus2.0 device" -> "AD Plus2.0", "the ZenCAM PLUS dash camera" -> "ZenCAM PLUS").
- Not equipment: a generic category ("dash camera", "remote starter", "the device"), a part of a device ("SIM card", "Micro SD card", "harness"), a vehicle make, model or year.
- If the question names no equipment, return {"equipment": []}.`;

const extractEquipmentNames = async (question) => {
  const response = await getOpenAIClient().chat.completions.create(
    {
      model: EXTRACT_MODEL,
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        { role: "user", content: question },
      ],
      response_format: { type: "json_object" },
    },
    { signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) }
  );
  const parsed = JSON.parse(response.choices?.[0]?.message?.content ?? "{}");
  return Array.isArray(parsed.equipment)
    ? [...new Set(parsed.equipment.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim()))]
    : [];
};

/** The catalog entries one name points at. */
const documentsNamed = (name, catalog) => {
  const key = squash(name);
  if (!key) return [];
  if (key.length >= MIN_SUBSTRING_LENGTH) return catalog.filter((entry) => entry.squashed.includes(key));
  // Short code: every word of it must be a whole word of the title.
  const nameWords = words(name);
  return catalog.filter((entry) => nameWords.every((w) => entry.words.has(w)));
};

/** The live documents about any of these equipment names, by title. */
const documentsFor = (names, catalog) => {
  const byId = new Map();
  for (const name of names) for (const entry of documentsNamed(name, catalog)) byId.set(entry.docId, entry);
  return [...byId.values()];
};

/**
 * The manuals a jobsheet's equipment points at, for the chat to show before anything is asked.
 * @returns {Promise<{ docId: string, title: string }[]>}
 */
export const manualsForEquipment = async (names) =>
  documentsFor(names, await getCatalog()).map((entry) => ({ docId: entry.docId, title: entry.title }));

/**
 * @param {string} question  the standalone question (follow-ups already rewritten)
 * @param {string[]} [jobEquipment]  the equipment of the jobsheet the chat was opened from; used when the question names none
 * @returns {Promise<{ equipment: string[], docIds: string[] | null, from: "question" | "job" | null }>}
 *   docIds is null when retrieval should not be filtered.
 */
export const resolveEquipmentFilter = async (question, jobEquipment = []) => {
  try {
    const [asked, catalog] = await Promise.all([extractEquipmentNames(question).catch(() => []), getCatalog()]);
    const from = asked.length > 0 ? "question" : jobEquipment.length > 0 ? "job" : null;
    const equipment = from === "question" ? asked : jobEquipment;
    if (equipment.length === 0) return { equipment, docIds: null, from };

    const docIds = documentsFor(equipment, catalog).map((entry) => entry.docId);

    // Equipment named but nothing in the catalog is about it: searching everything is still the best chance.
    if (docIds.length === 0) {
      logger.info(`[equipment] "${equipment.join(", ")}" (from the ${from}) matches no document title; not filtering`);
      return { equipment, docIds: null, from };
    }

    logger.info(`[equipment] "${equipment.join(", ")}" (from the ${from}) -> ${docIds.length} document(s)`);
    return { equipment, docIds, from };
  } catch (err) {
    logger.warn(`[equipment] lookup failed (${err.message}); not filtering`);
    return { equipment: [], docIds: null, from: null };
  }
};
