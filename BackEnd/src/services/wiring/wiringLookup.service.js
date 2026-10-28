import { findDrigWiring, listDrigMakes, listDrigModels } from "../../db/drigWiring.js";
import { findWiresheetWiring, listWiresheetMakes, listWiresheetModels } from "../../db/wiresheet.js";
import { makeKeys, squash, describeVehicle, START_TYPE_LABEL } from "./vehicleNames.js";
import { signUrl } from "./wiringBuckets.js";
import { logger } from "../../utils/logger.js";

// The chat's vehicle wiring answer. Exact lookups only (year, make, model,
// start type), never a nearby year and never a document search:
//
//   1. DRIG's own wiring guide, always first. A circuit DRIG has a usable value
//      for is answered from DRIG only, even when Wiresheet also has the vehicle.
//   2. Wiresheet, per circuit, ONLY when DRIG has nothing usable for it: no
//      row, a blank cell, a link that needs a Directechs login, a broken link.
//      Always labelled as Wiresheet (written for remote-start installs).
//   3. Neither: say so and send the technician to QC (Todd, Q8).
//
// The answer is composed here from the stored values, verbatim. No language
// model writes it, so nothing can be paraphrased into a different wire.

const CIRCUIT_LABEL = { "12v": "12V constant", ignition: "Ignition" };
const MAX_IMAGES = 4;
const WIRESHEET_MAX_VARIANTS = 3;
const PDF_EXCERPT_CHARS = 700;

// ---------------------------------------------------------------------------
// Names -> keys
// ---------------------------------------------------------------------------

let wiresheetMakesCache = null;
const wiresheetMakes = async () => {
  if (wiresheetMakesCache && wiresheetMakesCache.expiresAt > Date.now()) return wiresheetMakesCache.makes;
  const makes = (await listWiresheetMakes()).map((m) => ({ name: m.make, keys: makeKeys(m.make) }));
  wiresheetMakesCache = { makes, expiresAt: Date.now() + 10 * 60_000 };
  return makes;
};

/**
 * The keys a technician's vehicle answers to. "Dodge" + "Ram 1500" also tries
 * make "ram" + model "1500", because the sources file it that way.
 */
const vehicleKeys = ({ make, model }) => {
  const mKeys = new Set(makeKeys(make));
  const modelKeys = new Set([squash(model)]);
  const words = String(model ?? "").trim().split(/\s+/);
  if (words.length > 1) {
    const leading = makeKeys(words[0]);
    if (leading.length > 0 && (leading.some((k) => mKeys.has(k)) || ["ram", "mini", "smart"].includes(leading[0]))) {
      leading.forEach((k) => mKeys.add(k));
      modelKeys.add(squash(words.slice(1).join(" ")));
    }
  }
  return { makeKeys: [...mKeys], modelKeys: [...modelKeys].filter(Boolean) };
};

const wiresheetNamesFor = async (keys) => (await wiresheetMakes()).filter((m) => m.keys.some((k) => keys.includes(k))).map((m) => m.name);

// ---------------------------------------------------------------------------
// DRIG
// ---------------------------------------------------------------------------

const UNUSABLE_REASON = {
  empty: "the DRIG guide's cell is blank",
  icon: "the DRIG guide's cell has no wiring information",
  requires_login: "the DRIG guide links to a page that needs a Directechs login",
  unsupported: "the DRIG guide's link is not a file we can open",
  failed: "the DRIG guide's link could not be opened",
  pending: "the DRIG guide's link has not been imported yet",
};

/** One DRIG cell -> what can be shown for it, or why it can't. */
const drigValue = (hit) => {
  if (hit.cellKind === "text") return { usable: true, kind: "text", text: hit.cellText };
  if (hit.cellKind === "link" && hit.linkStatus === "stored" && hit.asset) return { usable: true, kind: hit.asset.kind, asset: hit.asset, label: hit.cellText };
  if (hit.cellKind === "link") return { usable: false, reason: UNUSABLE_REASON[hit.linkStatus ?? "pending"] ?? UNUSABLE_REASON.failed };
  return { usable: false, reason: UNUSABLE_REASON[hit.cellKind] };
};

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * @param {{ year: number, make: string, model: string, startType: "pts"|"key", circuits: ("12v"|"ignition")[] }} vehicle
 */
export const lookupVehicleWiring = async (vehicle) => {
  const { makeKeys: mKeys, modelKeys } = vehicleKeys(vehicle);
  const query = { makeKeys: mKeys, modelKeys, year: vehicle.year, startType: vehicle.startType };
  const [drigHits, wsMakes] = await Promise.all([findDrigWiring(query), wiresheetNamesFor(mKeys)]);

  const results = [];
  let wiresheetHits = null;
  for (const circuit of vehicle.circuits) {
    // Rows split by start type come first (the query orders them so).
    const candidates = drigHits.filter((h) => h.circuit === circuit);
    const values = candidates.map((h) => ({ hit: h, value: drigValue(h) }));
    const usable = values.find((v) => v.value.usable);
    if (usable) {
      results.push({ circuit, source: "drig", hit: usable.hit, value: usable.value });
      continue;
    }

    wiresheetHits ??= await findWiresheetWiring({ makes: wsMakes, modelKeys, year: vehicle.year, startType: vehicle.startType });
    // The same wire is sometimes listed twice on one page; and one vehicle can have a few VIN variants.
    const seen = new Set();
    const ws = wiresheetHits.filter((h) => h.circuit === circuit && !seen.has(h.cellRaw) && seen.add(h.cellRaw)).slice(0, WIRESHEET_MAX_VARIANTS);
    const drigReason = values[0]?.value.reason ?? (drigHits.length > 0 ? "the DRIG guide has no value for it" : "the vehicle is not in the DRIG guide");
    results.push(ws.length > 0 ? { circuit, source: "wiresheet", hits: ws, drigReason } : { circuit, source: null, drigReason });
  }

  const drigRow = drigHits[0] ?? null;
  return { vehicle, results, drigRow, anyFound: results.some((r) => r.source) };
};

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

const ocrLines = (asset) => {
  if (asset.ocrStatus !== "done" || !asset.ocrText) return null;
  const notes = asset.ocrJson?.notes ? `\nOn the photo: ${asset.ocrJson.notes}` : "";
  const caution = asset.ocrJson?.confidence === "low" ? " Some of it was hard to read." : "";
  return { text: `${asset.ocrText}${notes}`, caution };
};

const drigLine = (r) => {
  const label = CIRCUIT_LABEL[r.circuit];
  if (r.value.kind === "text") return `${label}: ${r.value.text}`;

  const name = r.value.label ? ` "${r.value.label}"` : "";
  const reading = ocrLines(r.value.asset);
  if (r.value.kind === "pdf") {
    if (reading) return `${label}: DRIG guide${name}, page 1 reads (confirm on the guide):\n${reading.text}`;
    const excerpt = (r.value.asset.textLayer ?? "").trim();
    if (excerpt) return `${label}: DRIG guide${name} (open it below):\n${excerpt.length > PDF_EXCERPT_CHARS ? `${excerpt.slice(0, PDF_EXCERPT_CHARS).trimEnd()}…` : excerpt}`;
    return `${label}: see the DRIG guide${name} below.`;
  }
  if (reading) return `${label}: DRIG photo${name} reads (confirm on the photo before tapping):${reading.caution}\n${reading.text}`;
  return `${label}: see the DRIG photo${name} below. Its text could not be read automatically, so check the photo itself.`;
};

const wiresheetLine = (r) => {
  const label = CIRCUIT_LABEL[r.circuit];
  const variants = r.hits.map((h) => (r.hits.length > 1 && h.title ? `${h.cellRaw}  [${h.title}]` : h.cellRaw));
  return (
    `${label}: not in the DRIG guide (${r.drigReason}), so this is from Wiresheet. ` +
    `Wiresheet is written for remote-start installs and can differ from DRIG's standard:\n${variants.join("\n")}`
  );
};

const missingLine = (r) => `${CIRCUIT_LABEL[r.circuit]}: not in the DRIG guide or Wiresheet for this vehicle (${r.drigReason}). Call QC before tapping anything.`;

/**
 * The technician-facing answer + the pictures to show with it (signed links).
 * `images[].stored` is what the chat history keeps to re-sign them later.
 */
export const composeWiringAnswer = async (lookup) => {
  const { vehicle, results } = lookup;
  const usedDrig = results.some((r) => r.source === "drig");
  const usedWiresheet = results.some((r) => r.source === "wiresheet");
  const sourceNote = usedDrig && !usedWiresheet ? "from the DRIG wiring guide" : usedDrig ? "from the DRIG wiring guide, with Wiresheet where DRIG has nothing" : "from Wiresheet (not in the DRIG guide)";

  const rowNote = lookup.drigRow ? ` (DRIG guide row ${lookup.drigRow.sourceRow}: ${lookup.drigRow.year} ${lookup.drigRow.makeRaw} ${lookup.drigRow.modelRaw})` : "";
  const lines = [`${describeVehicle(vehicle)}, ${sourceNote}${usedDrig ? rowNote : ""}.`];
  for (const r of results) lines.push(r.source === "drig" ? drigLine(r) : r.source === "wiresheet" ? wiresheetLine(r) : missingLine(r));
  lines.push("Check every wire on the vehicle before tapping, and never tap an airbag circuit. If anything doesn't match, call QC.");

  const images = [];
  const seenKeys = new Set();
  const addImage = async (stored, label) => {
    if (images.length >= MAX_IMAGES || seenKeys.has(stored.key)) return;
    seenKeys.add(stored.key);
    try {
      const url = await signUrl(stored.bucket, stored.key);
      const href = stored.hrefKey && stored.hrefKey !== stored.key ? await signUrl(stored.bucket, stored.hrefKey, { downloadName: stored.downloadName }) : url;
      images.push({ label, url, href, page: null, document_id: null, stored: { ...stored, label } });
    } catch (err) {
      logger.warn(`[wiring] could not sign ${stored.bucket}/${stored.key}: ${err.message}`);
    }
  };

  for (const r of results) {
    if (r.source === "drig" && r.value.asset) {
      const a = r.value.asset;
      const what = a.kind === "pdf" ? "guide" : "photo";
      await addImage(
        { bucket: "drig_wiring", key: a.previewKey ?? a.s3Key, hrefKey: a.s3Key, downloadName: a.kind === "pdf" ? `${r.value.label ?? "DRIG wiring guide"}.pdf` : undefined },
        `DRIG wiring guide ${what} · ${r.hit.year} ${r.hit.makeRaw} ${r.hit.modelRaw} · ${CIRCUIT_LABEL[r.circuit]}${r.value.label ? ` (${r.value.label})` : ""}`
      );
    }
    if (r.source === "wiresheet") {
      for (const h of r.hits.filter((x) => x.imageS3Key)) {
        await addImage({ bucket: "wiresheet", key: h.imageS3Key }, `Wiresheet photo · ${h.title ?? `${h.year} ${h.make} ${h.model}`} · ${CIRCUIT_LABEL[r.circuit]}`);
      }
    }
  }

  return { answer: lines.join("\n\n"), images };
};

// ---------------------------------------------------------------------------
// The vehicle picker
// ---------------------------------------------------------------------------

/**
 * Makes, or a make's models with their years and start types, from BOTH the
 * DRIG guide and Wiresheet, so the picker offers every vehicle either can answer.
 */
export const vehicleOptions = async ({ make } = {}) => {
  if (!make) {
    const [drig, ws] = await Promise.all([listDrigMakes(), wiresheetMakes()]);
    // One entry per make key: "Dodge/Ram" in the DRIG guide covers Wiresheet's "Dodge" and "Ram".
    const byKey = new Map();
    for (const name of [...drig.flatMap((m) => m.split(/\s*\/\s*/)), ...ws.map((m) => m.name)]) {
      const key = makeKeys(name)[0];
      if (key && !byKey.has(key)) byKey.set(key, name);
    }
    return { makes: [...byKey.values()].sort((a, b) => a.localeCompare(b)) };
  }

  const keys = makeKeys(make);
  const [drig, ws] = await Promise.all([listDrigModels(keys), wiresheetNamesFor(keys).then(listWiresheetModels)]);
  const byKey = new Map();
  for (const m of [...drig, ...ws]) {
    const key = squash(m.model);
    const prev = byKey.get(key);
    byKey.set(key, {
      model: prev?.model ?? m.model,
      years: [...new Set([...(prev?.years ?? []), ...m.years])].sort((a, b) => a - b),
      startTypes: [...new Set([...(prev?.startTypes ?? []), ...m.startTypes])],
    });
  }
  return {
    make,
    models: [...byKey.values()].sort((a, b) => a.model.localeCompare(b.model)),
    startTypes: Object.entries(START_TYPE_LABEL).map(([value, label]) => ({ value, label })),
  };
};
