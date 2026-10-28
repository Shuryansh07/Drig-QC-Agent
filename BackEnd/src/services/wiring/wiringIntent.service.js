import { getOpenAIClient } from "../../config/openaiClient.js";
import { normalizeStartType } from "./vehicleNames.js";
import { logger } from "../../utils/logger.js";

// Is this a vehicle wiring lookup ("2016 ILX push to start, where's ignition?")
// and which vehicle is it about? A vehicle lookup is answered from the DRIG
// wiring guide / Wiresheet tables by exact match, never by document search, so
// this decides which path a question takes.
//
// A keyword pre-check runs first: most questions are about equipment manuals
// and never mention a 12V / ignition / wiring word, so they skip the AI call.

const INTENT_MODEL = process.env.OPENAI_WIRING_INTENT_MODEL || process.env.OPENAI_EQUIPMENT_MODEL || "gpt-4o-mini";
const INTENT_TIMEOUT_MS = parseInt(process.env.WIRING_INTENT_TIMEOUT_MS || "6000", 10);
const ENABLED = process.env.WIRING_ROUTE_ENABLED !== "false";

// The pre-check must not be stricter than the technicians' typing: phones produce "ingnition",
// "ignision", "igntion". So it passes on a wiring word, a misspelt ignition, a model year or a
// vehicle make, and leaves the actual decision to the model, which reads typos fine.
const MAYBE_WIRING_RE = /\b(?:12\s*-?\s*v(?:olts?)?|twelve\s*volt|constant|battery|b\+|ign\w*|acc(?:essory)?|wir(?:e|es|ing)|tap|hot\s*lead|power\s*(?:wire|source|lead))\b/i;
const IGNITION_TYPO_RE = /\bi[a-z]{0,2}n[a-z]{0,3}(?:tion|sion|ton|tin)\b/i;
const MODEL_YEAR_RE = /\b(?:19[5-9]\d|20[0-4]\d)\b/;
const MAKE_RE =
  /\b(?:acura|alfa|audi|bmw|buick|cadillac|chevy|chevrolet|chrysler|dodge|ram|fiat|ford|freightliner|genesis|gmc|honda|hummer|hyundai|infiniti|isuzu|jaguar|jeep|kenworth|kia|land\s*rover|lexus|lincoln|mazda|mercedes|benz|mercury|mini|mitsubishi|nissan|peterbilt|pontiac|porsche|saab|saturn|scion|subaru|suzuki|tesla|toyota|volkswagen|vw|volvo|international|navistar|mack|hino)\b/i;

const mightBeWiring = (question) =>
  MAYBE_WIRING_RE.test(question) || IGNITION_TYPO_RE.test(question) || MODEL_YEAR_RE.test(question) || MAKE_RE.test(question);

const PROMPT = `You route questions from vehicle installation technicians (GPS trackers, cameras, lights). Decide if the question asks WHERE or WHICH wire to use IN THE VEHICLE for constant 12V power or ignition, and pull out the vehicle.

Return JSON only:
{
  "vehicle_wiring": true|false,
  "circuits": ["12v" and/or "ignition"],
  "year": <4-digit model year or null>,
  "make": "<vehicle make as written, or null>",
  "model": "<vehicle model as written, without trim words like 'push to start' or 'key', or null>",
  "start_type": "push_to_start" | "key" | null
}

vehicle_wiring is TRUE when the technician wants the vehicle's constant/battery 12V wire, its ignition wire, or "the wiring" / "where to tap power" for a vehicle — even if the vehicle is not named yet ("Which wire is the ignition wire?"), and even when it is misspelt or brief ("2018 equinox ingnition help", "need 12v f150").
vehicle_wiring is FALSE when:
- the question is about a device's own harness or wire colours ("which wire on the VT-2300 harness is ignition", "what does the red wire on the camera do"),
- it is about any other vehicle circuit (door locks, starter kill, tach, brake, parking lights, CAN),
- it is a general troubleshooting or installation question that is not asking for a vehicle wire.

circuits: "12v" for constant / battery / always-hot power, "ignition" for ignition / switched power. Both when the question asks for "the wiring" or "power and ignition". Empty when vehicle_wiring is false.
start_type: "push_to_start" for push-button / keyless start / PTS, "key" for a keyed / turn-key ignition. null if not stated. Never guess it from the model.
Never invent a year, make or model that is not in the question.`;

const toYear = (value) => {
  const n = Number(String(value ?? "").trim());
  return Number.isInteger(n) && n >= 1950 && n <= 2100 ? n : null;
};

const clean = (value) => {
  const text = typeof value === "string" ? value.trim().slice(0, 60) : "";
  return text && !/^(null|none|unknown|n\/a)$/i.test(text) ? text : null;
};

/**
 * @returns {Promise<null | { circuits: ("12v"|"ignition")[], year: number|null, make: string|null, model: string|null, startType: "pts"|"key"|null }>}
 *   null: not a vehicle wiring lookup (or the check failed) — answer from the manuals as usual.
 */
export const detectWiringIntent = async (question) => {
  if (!ENABLED || !mightBeWiring(question)) return null;
  try {
    const response = await getOpenAIClient().chat.completions.create(
      {
        model: INTENT_MODEL,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: question.slice(0, 1000) },
        ],
        response_format: { type: "json_object" },
      },
      { signal: AbortSignal.timeout(INTENT_TIMEOUT_MS) }
    );
    const parsed = JSON.parse(response.choices?.[0]?.message?.content ?? "{}");
    if (parsed.vehicle_wiring !== true) return null;

    const circuits = [...new Set((Array.isArray(parsed.circuits) ? parsed.circuits : []).filter((c) => c === "12v" || c === "ignition"))];
    return {
      circuits: circuits.length > 0 ? circuits : ["12v", "ignition"],
      year: toYear(parsed.year),
      make: clean(parsed.make),
      model: clean(parsed.model),
      startType: normalizeStartType(String(parsed.start_type ?? "").replace(/_/g, " ")),
    };
  } catch (err) {
    // A failed check must never cost the technician an answer: fall back to the manuals.
    logger.warn(`[wiring] intent check failed (${err.message}); answering from the manuals`);
    return null;
  }
};

export const missingVehicleFields = (intent) =>
  [!intent.year && "year", !intent.make && "make", !intent.model && "model", !intent.startType && "startType"].filter(Boolean);
