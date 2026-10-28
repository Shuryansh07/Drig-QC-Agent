// Vehicle names come from three places that spell them differently: the DRIG
// wiring guide ("Dodge/Ram", "Mercedes", "ILX PTS"), the scraped Wiresheet data
// ("Dodge", "Mercedes Benz", "ILX" + key type "Push To Start") and whatever the
// technician typed or picked. Everything is compared through these keys, so a
// lookup is exact on meaning but not on punctuation or case.

/** "F-150 " -> "f150", "C/V" -> "cv". */
export const squash = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// One spelling -> the key(s) it stands for. A sheet that files two makes under
// one name ("Dodge/Ram") answers to both.
const MAKE_ALIASES = {
  mercedesbenz: ["mercedes"],
  mercedes: ["mercedes"],
  benz: ["mercedes"],
  chevy: ["chevrolet"],
  vw: ["volkswagen"],
  dodgeram: ["dodge", "ram"],
  rangerover: ["landrover"],
};

/**
 * Normalised make keys. "Dodge/Ram" -> ["dodge", "ram"], "Mercedes Benz" ->
 * ["mercedes"], "MINI" -> ["mini"]. Never empty for a non-blank name.
 */
export const makeKeys = (make) => {
  const raw = String(make ?? "").trim();
  if (!raw) return [];
  const whole = squash(raw);
  const parts = raw.split(/[/&,]+/).map(squash).filter(Boolean);
  const keys = new Set();
  for (const part of [whole, ...parts]) {
    for (const key of MAKE_ALIASES[part] ?? [part]) keys.add(key);
  }
  // A joined name that is only there because of the slash ("dodgeram") is not a make of its own.
  if (parts.length > 1 && !MAKE_ALIASES[whole]) keys.delete(whole);
  return [...keys];
};

const PTS_RE = /\b(?:pts|push[\s-]*(?:button[\s-]*)?(?:to[\s-]*)?start|keyless[\s-]*(?:start|go|ignition)|proximity)\b/i;
const KEY_RE = /\b(?:key(?:ed)?|standard[\s-]*key|turn[\s-]*key|intelli[\s-]*key)\b/i;

/**
 * What a technician (or a picker) said about the start type -> 'pts' | 'key' | null.
 * Push-to-start is tested first: "keyless push to start" is push-to-start.
 */
export const normalizeStartType = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (PTS_RE.test(text)) return "pts";
  if (KEY_RE.test(text)) return "key";
  return null;
};

/** Wiresheet's own key-type text: "Push To Start" -> pts; "Standard Key" and Chrysler's inserted "Intelli-Key" fob -> key. */
export const wiresheetStartType = (keyType) => {
  if (!keyType) return null;
  return /push\s*to\s*start/i.test(keyType) ? "pts" : "key";
};

/**
 * A DRIG sheet model cell -> its base model and start type.
 * "ILX PTS" -> { model: "ILX", startType: "pts" }, "Expedition Key" -> { "Expedition", "key" },
 * "CSX" -> { "CSX", null } (not split by start type: applies to both).
 */
export const parseSheetModel = (modelRaw) => {
  const raw = String(modelRaw ?? "").trim();
  const startType = normalizeStartType(raw);
  let model = raw;
  if (startType) {
    model = raw
      .replace(new RegExp(PTS_RE.source, "gi"), " ")
      .replace(new RegExp(KEY_RE.source, "gi"), " ")
      .replace(/[\s,()/-]+$/g, "")
      .replace(/^[\s,()/-]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return { model: model || raw, startType };
};

export const START_TYPE_LABEL = { pts: "push to start", key: "keyed ignition" };

/** "2016 Acura ILX (push to start)". */
export const describeVehicle = ({ year, make, model, startType }) =>
  `${year} ${make} ${model}${startType ? ` (${START_TYPE_LABEL[startType]})` : ""}`;
