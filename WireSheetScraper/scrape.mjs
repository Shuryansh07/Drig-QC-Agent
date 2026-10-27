// Exports the "12 Volts" and "Ignition" wires (and their photos) from WireSheet, for every
// make -> year -> model -> key type the site offers. Needs a dealer (subscriber) login.

//   $env:WIRESHEET_PASSWORD = "<your WireSheet dealer password>"     # the scraper logs in and keeps the session
//   # or, instead: $env:WIRESHEET_COOKIE = "<Cookie header copied from a logged-in browser>"
//   WIRESHEET_DATABASE_URL (or DATABASE_URL)                         # progress + scraped data live in Postgres, not files
//   AWS creds (default chain) + S3_WIRESHEET_BUCKET (default qc-wiresheet), S3_REGION   # photos go to S3; see .env.example
//   node scrape.mjs --probe                  # check login + endpoint shapes, no DB/S3 needed, writes nothing
//   node scrape.mjs --make Ford --year 2015   # one slice
//   node scrape.mjs                           # everything (resumes from the database where it stopped)
//   node scrape.mjs --parse-file ../WireSheet.html   # test the parser on a saved page, offline (no DB/S3)

// Flags: --out <dir> (default data/wiresheet, only for --save-pages and the tracker.xlsx output)
//        --delay <ms> (default 1500)  --no-images  --no-s3
//        --all-wires (keep every wire, not only 12V/ignition)  --dedupe (kept for compat; resume is always on)
//        --photos-only (store only wires that have a photo)
//        --make <name>  --year <yyyy>  --limit <n> (stop after n cars that have a 12V/ignition photo)  --max-scan <n> (give up after looking at n cars)  --save-pages (keep each car's raw page in <out>/pages for inspection)
//        --report (rebuild tracker.xlsx from the database; signs photo links against S3)

// Storage: all progress and scraped data are rows in the database (see
// BackEnd/db/migrations/..._wiresheet.sql) so the scraper resumes after a Fargate
// restart with no local state —
//   wiresheet_scrape_combo  which make/year/model combos are finished (was done.json)
//   wiresheet_vehicle       one row per scraped vehicle, status and all (was vehicles.jsonl)
//   wiresheet_entry         the 12V / ignition wires kept per vehicle (was vehicles.jsonl .wires)
//   wiresheet_image(_source) photos, by content hash + source URL (was uploaded-images.json)
// Photos themselves go to the qc-wiresheet S3 bucket (img/<sha256>.<ext>, thumb/<sha256>.jpg);
// only the object KEY is stored in the DB, never a URL. tracker.xlsx (written to --out) is a
// convenience rebuilt from the DB: a row per 12V/ignition option of each car, with a thumbnail
// and a signed-URL photo link that expires after REPORT_LINK_DAYS.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parse } from "node-html-parser";
import ExcelJS from "exceljs";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as db from "./db.mjs";

const BASE = "https://www.wiresheet.com";
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const OUT = path.resolve(opt("out", "data/wiresheet"));
const DELAY_MS = Number(opt("delay", "1500"));
const WITH_IMAGES = !flag("no-images");
const ALL_WIRES = flag("all-wires");
const DEDUPE = flag("dedupe");
// Every car is listed in the tracker. This only trims the Wires sheet to wires that have a photo.
const PHOTOS_ONLY = flag("photos-only");
const ONLY_MAKE = opt("make", "");
const ONLY_YEAR = opt("year", "");
const LIMIT = Number(opt("limit", "0"));
const MAX_SCAN = Number(opt("max-scan", "0"));
const SAVE_PAGES = flag("save-pages");
const PASSWORD = process.env.WIRESHEET_PASSWORD ?? "";
const WITH_S3 = WITH_IMAGES && !flag("no-s3");

// ---------------------------------------------------------------------------
// S3: photos go to the dedicated qc-wiresheet bucket, keyed by content hash
// (img/<sha256>.<ext>), so the same car's photo reused across years/models is
// uploaded once. Only the object KEY is kept (in the database, never a URL —
// DATABASE.md: "store object keys only, never full URLs or bucket names"); the
// tracker signs a short-lived URL from the key when it is built (see writeReport()).
// ---------------------------------------------------------------------------
const S3_REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";
const S3_PREFIX = process.env.S3_WIRESHEET_PREFIX ?? ""; // the bucket is dedicated, so no prefix by default
const S3_IMG_PREFIX = `${S3_PREFIX}img/`;
const S3_THUMB_PREFIX = `${S3_PREFIX}thumb/`;
const REPORT_LINK_DAYS = Number(process.env.WIRESHEET_REPORT_LINK_DAYS || "7");

let s3Client;
const s3 = () => (s3Client ??= new S3Client({ region: S3_REGION }));
const s3Bucket = () => process.env.S3_WIRESHEET_BUCKET || "qc-wiresheet";

const ensureS3 = async () => {
  if (!WITH_S3) return;
  await s3().send(new HeadBucketCommand({ Bucket: s3Bucket() })).catch((err) => {
    throw new Error(`Cannot reach S3 bucket "${s3Bucket()}" (${err.message}). Check AWS creds / S3_WIRESHEET_BUCKET / S3_REGION, or pass --no-s3.`);
  });
};

const putS3 = async (key, buffer, contentType) => {
  await s3().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: buffer, ContentType: contentType }));
};

const getS3Buffer = async (key) => {
  const res = await s3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
};

// Session cookies: seeded from WIRESHEET_COOKIE if given, then kept up to date from every response.
const jar = new Map();
for (const part of (process.env.WIRESHEET_COOKIE ?? "").split(";")) {
  const [name, ...rest] = part.trim().split("=");
  if (name) jar.set(name, rest.join("="));
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const storeCookies = (res) => {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const [name, ...rest] = pair.split("=");
    if (name?.trim()) jar.set(name.trim(), rest.join("="));
  }
};
const USER_AGENT = process.env.WIRESHEET_UA ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// A wire is kept when its function name is a 12 V feed or an ignition circuit.
// Only the "Constant +12 Volts" wires (all of them when there are several: "Constant +12 Volts (2)") and the
// plain "Ignition" wires (and "Ignition (2)"). OBD 12 Volts, Ignition Interrupt, Ignition Sense and the rest are not wanted.
const IS_12V_WIRE = /^constant\s*\+?\s*12\s*v(olts?)?(\s*\(\d+\))?$/i;
const IS_IGNITION_WIRE = /^ignition(\s*\(\d+\))?$/i;
const WANTED = { test: (name) => IS_12V_WIRE.test(name) || IS_IGNITION_WIRE.test(name) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (text) => String(text ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Parsing the vehicle page
// ---------------------------------------------------------------------------

/** One wire row per function: its colour, polarity, location, optional note and photo link. */
export const parseWires = (html) => {
  // Text-based on purpose: the live pages have stray closing tags and unclosed divs that make a DOM
  // parser drop or merge rows. Every row is a `<tr class="rowN">` chunk, every wanted cell a td with
  // class "wires" (or "wires polarity"); cells marked "noprint" hold buttons, not data.
  const text = (fragment) => clean(parse(`<p>${fragment}</p>`).text);
  const sections = [...html.matchAll(/<div class="titlerow wire_title"[^>]*>\s*<div[^>]*>([\s\S]*?)<\/div>/g)].map((m) => ({ at: m.index, name: text(m[1]) }));
  const rows = [...html.matchAll(/<tr class="row\d+">([\s\S]*?)(?=<tr class="row\d+">|<\/table>)/g)];

  const wires = [];
  let current = null;
  for (const row of rows) {
    const chunk = row[1];

    const note = /<td[^>]*class="[^"]*wirenote[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(chunk);
    if (note) {
      if (current) current.notes = clean(text(note[1]).replace(/^\s*Notes:/i, ""));
      continue;
    }

    const cells = [...chunk.matchAll(/<td[^>]*class="wires(?: polarity)?"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const fn = /<strong>([\s\S]*?)<\/strong>/.exec(cells[0] ?? "");
    if (!fn || cells.length < 4) continue;

    const section = [...sections].reverse().find((s) => s.at < row.index)?.name ?? "";
    current = {
      section,
      function: text(fn[1]),
      color: text(cells[1]),
      polarity: text(cells[2]),
      location: text(cells[3]),
      notes: "",
      imageUrl: /IMGbuttonclick\(\s*(?:'|"|&#39;|&quot;)(https?:[^'")\s]+)/.exec(chunk)?.[1] ?? null,
    };
    wires.push(current);
  }
  return wires;
};

/** The heading above the table, e.g. "2026 Ford Bronco - Push To Start (VIN 10th Digit: T)". */
export const parseTitle = (html) => {
  const text = clean(parse(html).text);
  return /\b(19|20)\d{2}\s[^|]{3,80}?\(VIN 10th Digit:\s*\w\)/.exec(text)?.[0] ?? "";
};

// ---------------------------------------------------------------------------
// HTTP: one request at a time, spaced out, retried, cookie sent to wiresheet.com only
// ---------------------------------------------------------------------------

let lastRequestAt = 0;
const pace = async () => {
  const wait = lastRequestAt + DELAY_MS - Date.now();
  lastRequestAt = Math.max(Date.now(), lastRequestAt + DELAY_MS);
  if (wait > 0) await sleep(wait);
};

class LoginError extends Error {}

const request = async (url, init = {}, { retries = 4, expect = "text" } = {}) => {
  for (let attempt = 0; ; attempt++) {
    await pace();
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, Cookie: cookieHeader(), Accept: "*/*", ...init.headers },
        signal: AbortSignal.timeout(30_000),
      });
      storeCookies(res);
      // A lapsed session bounces to the login page: there is no point retrying.
      if (/index\.asp/i.test(res.url) && !/index\.asp/i.test(url)) throw new LoginError("Redirected to the login page");
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return expect === "json" ? await res.json() : await res.text();
    } catch (err) {
      // Session lapsed mid-crawl: log in again once per request and retry it.
      if (err instanceof LoginError && PASSWORD && attempt < retries && !url.includes("skgaterespond")) {
        console.warn("  session expired, logging in again");
        await login();
        continue;
      }
      if (err instanceof LoginError || err.fatal || attempt >= retries) throw err;
      const backoff = Math.min(60_000, 2000 * 2 ** attempt);
      console.warn(`  retry ${attempt + 1}/${retries} in ${Math.round(backoff / 1000)}s (${err.message})`);
      await sleep(backoff);
    }
  }
};

const apiJson = async (url) => {
  try {
    const data = await request(url, {}, { expect: "json" });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err instanceof LoginError) throw err;
    // Not JSON (an HTML error page): treat as "no choices" but say so, the caller logs the combination.
    return [];
  }
};

/** Dealer login: one password box, posted to skgaterespond.asp. The session cookie comes back in Set-Cookie. */
const login = async () => {
  jar.clear();
  const headers = { "User-Agent": USER_AGENT };
  const first = await fetch(`${BASE}/v3/index.asp?logstat=x`, { headers, signal: AbortSignal.timeout(30_000) });
  storeCookies(first);

  await pace();
  let res = await fetch(`${BASE}/v3/skgaterespond.asp`, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, Cookie: cookieHeader(), "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/v3/index.asp?logstat=x` },
    body: new URLSearchParams({ userpassword: PASSWORD, logsubmit: "LOG IN" }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  storeCookies(res);
  // Follow the redirect chain by hand so every hop's cookies are kept.
  for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400 && res.headers.get("location"); hop++) {
    await pace();
    res = await fetch(new URL(res.headers.get("location"), res.url || BASE), {
      redirect: "manual",
      headers: { ...headers, Cookie: cookieHeader() },
      signal: AbortSignal.timeout(30_000),
    });
    storeCookies(res);
  }

  await pace();
  const check = await fetch(`${BASE}/v3/wiresheet.asp`, { headers: { ...headers, Cookie: cookieHeader() }, signal: AbortSignal.timeout(30_000) });
  storeCookies(check);
  const html = await check.text();
  if (/index\.asp/i.test(check.url) || !/id="make"/.test(html)) {
    throw new Error("Login failed: the site did not accept WIRESHEET_PASSWORD (wrong password, or the account is not enabled for WireSheet).");
  }
  console.log("Logged in.");
};

const qs = (params) => new URLSearchParams(params).toString();
// The page fills these lists from JSON endpoints (the make <select> is empty in the HTML), so
// call them directly. Years and models exist on two paths; the second is tried when the first is empty.
const firstNonEmpty = async (...urls) => {
  for (const url of urls) {
    const data = await apiJson(url);
    if (data.length > 0) return data;
  }
  return [];
};
const getMakes = async () => {
  const list = await apiJson(`${BASE}/v3/wiresheet.asp?${qs({ api: "makes" })}`);
  const names = list.map((m) => (typeof m === "string" ? m : (m.make ?? m.name ?? ""))).filter(Boolean);
  if (names.length > 0) return names;
  // Fallback: older markup with the options in the HTML.
  const html = await request(`${BASE}/v3/wiresheet.asp`);
  return parse(html).querySelectorAll("select#make option").map((o) => o.getAttribute("value")).filter(Boolean);
};
const getYears = async (make) =>
  (await firstNonEmpty(`${BASE}/v3/wiresheet.asp?${qs({ api: "years", make })}`, `${BASE}/v3/wiresheet-api2.asp?${qs({ api: "years", make })}`)).map((y) =>
    String(y.year ?? y),
  ).filter(Boolean);
const getModels = async (make, year) =>
  (await firstNonEmpty(`${BASE}/v3/wiresheet.asp?${qs({ api: "models", make, year })}`, `${BASE}/v3/wiresheet-api2.asp?${qs({ api: "models", make, year })}`))
    .map((m) => (typeof m === "string" ? m : (m.model ?? m.name ?? m.m ?? "")))
    .filter(Boolean);
const getKeys = async (make, year, model) =>
  (await apiJson(`${BASE}/v3/wiresheet.asp?${qs({ api: "keys", make, year, model })}`))
    .map((k) => ({ recnum: String(k.profile_id ?? k.pid ?? k.veh_id ?? ""), keyType: String(k.key_type ?? k.kt ?? "") }))
    .filter((k) => k.recnum);
const getVehiclePage = (make, year, model, key) =>
  request(`${BASE}/v3/wiresheet.asp`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/v3/wiresheet.asp` },
    body: qs({ WSmake: make, WSyear: year, WSmodel: model, key_type: key.keyType, recnum: key.recnum, profile_id: key.recnum, key_select: key.recnum }),
  });

// ---------------------------------------------------------------------------
// Images: the photo host is public, so no cookie is sent there. The original is
// uploaded to the qc-wiresheet S3 bucket by content hash and a thumbnail next
// to it; nothing is kept on disk. Dedup (a photo reused across years/models is
// uploaded once) and the "URL already fetched" check both live in the database
// now (wiresheet_image / wiresheet_image_source), so a Fargate restart resumes
// correctly without the old uploaded-images.json file.
// ---------------------------------------------------------------------------

let sharpModule;
const loadSharp = async () => {
  if (sharpModule === undefined) sharpModule = await import("sharp").then((m) => m.default).catch(() => null);
  return sharpModule;
};

const THUMB_WIDTH = 170;

/** A small JPEG of the photo, made in memory for the thumbnail stored in S3. Null when sharp is unavailable or the bytes are not an image. */
const makeThumb = async (buffer) => {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(buffer).metadata();
    const height = Math.max(40, Math.round((meta.height / meta.width) * THUMB_WIDTH));
    return { buffer: await sharp(buffer).resize({ width: THUMB_WIDTH }).jpeg({ quality: 70 }).toBuffer(), width: THUMB_WIDTH, height };
  } catch {
    return null; // not a readable image
  }
};

/** Content type from the file extension in the URL; S3 wants one and Wiresheet's own URLs don't send one back reliably. */
const contentTypeOf = (ext) => ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] ?? "application/octet-stream");

/**
 * Downloads one photo, uploads the original (and a thumbnail) to the qc-wiresheet
 * bucket keyed by content hash, and records it in the database — skipping the
 * upload when that hash, or that exact source URL, is already stored. Returns the
 * image row ({ imageId, s3Key, thumbKey, contentHash, width, height }) a wire links to.
 */
const downloadAndStoreImage = async (url) => {
  if (!WITH_S3) return null;

  const bySourceUrl = await db.imageBySourceUrl(url);
  if (bySourceUrl) return bySourceUrl;

  let buffer;
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(Math.max(300, DELAY_MS / 3));
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.ok) {
      buffer = Buffer.from(await res.arrayBuffer());
      break;
    }
    if (res && res.status < 500 && res.status !== 429) break; // 404 and the like will not get better
  }
  if (!buffer) return null;

  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const byHash = await db.imageByHash(hash);
  if (byHash) {
    await db.mapSourceUrl(url, byHash.imageId); // same bytes under a new URL: link, do not re-upload
    return byHash;
  }

  const ext = (path.extname(new URL(url).pathname).slice(1) || "jpg").toLowerCase();
  const s3Key = `${S3_IMG_PREFIX}${hash}.${ext}`;
  await putS3(s3Key, buffer, contentTypeOf(ext));

  const thumb = await makeThumb(buffer);
  let thumbKey = null;
  if (thumb) {
    thumbKey = `${S3_THUMB_PREFIX}${hash}.jpg`;
    await putS3(thumbKey, thumb.buffer, "image/jpeg");
  }

  return db.insertImage({ contentHash: hash, s3Key, thumbKey, width: thumb?.width ?? null, height: thumb?.height ?? null, sourceUrl: url });
};

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

const ensureAuth = async () => {
  if (PASSWORD) return login();
  if (jar.size === 0) {
    console.error("Set WIRESHEET_PASSWORD (your dealer password) or WIRESHEET_COOKIE (a Cookie header from a logged-in browser).");
    process.exit(2);
  }
};

const probe = async () => {
  const makes = await getMakes();
  console.log(`${makes.length} makes available. First: ${makes.slice(0, 5).join(", ")}`);
  if (makes.length === 0) {
    await fs.mkdir(OUT, { recursive: true });
    const raw = await request(`${BASE}/v3/wiresheet.asp?api=makes`);
    await fs.writeFile(path.join(OUT, "debug-makes-response.txt"), raw);
    console.error(`No makes came back. The raw response (${raw.length} bytes) is saved in ${path.join(OUT, "debug-makes-response.txt")}; first 300 characters:
${raw.slice(0, 300)}`);
    return;
  }
  const make = ONLY_MAKE || makes[0];
  const years = await getYears(make);
  console.log(`${make}: ${years.length} years`, years.slice(0, 6));
  const year = ONLY_YEAR || years[Math.floor(years.length / 2)];
  const models = await getModels(make, year);
  console.log(`${make} ${year}: ${models.length} models`, models.slice(0, 6));
  const keys = await getKeys(make, year, models[0]);
  console.log(`${make} ${year} ${models[0]}: keys`, keys);
  if (!keys[0]) return;
  const html = await getVehiclePage(make, year, models[0], keys[0]);
  console.log("Title:", parseTitle(html));
  const all = parseWires(html);
  if (all.length === 0) {
    await fs.mkdir(OUT, { recursive: true });
    const dump = path.join(OUT, "debug-vehicle-page.html");
    await fs.writeFile(dump, html);
    const flags = { bytes: html.length, hasWiretable: /wiretable/.test(html), hasVBUNDLE: /VBUNDLE/.test(html), hasLoginForm: /logonForm/.test(html), hasWSmake: /id="WSmake"/.test(html) };
    console.error(`No wires parsed. The page is saved to ${dump}.`, flags);
    console.error("Text of the page (first 400 characters):", clean(parse(html).text).slice(0, 400));
    return;
  }
  console.log(`${all.length} wires on the page, ${all.filter((w) => WANTED.test(w.function)).length} kept:`);
  console.table(all.filter((w) => WANTED.test(w.function)).map((w) => ({ fn: w.function, color: w.color, pol: w.polarity, image: w.imageUrl?.split("/").pop() ?? "" })));
};

const IS_12V = (w) => IS_12V_WIRE.test(w.function);
const IS_IGNITION = (w) => IS_IGNITION_WIRE.test(w.function);

/** 12v / ignition / other — the circuit column stored for each kept wire. */
const circuitOf = (w) => (IS_12V(w) ? "12v" : IS_IGNITION(w) ? "ignition" : "other");

/**
 * Every filter combination ends up as a wiresheet_vehicle row, whether or not it has data: a car
 * with wires, a car whose page has no wire table, a model with no key types, a year with no models.
 * `status` says which, and found12v / foundIgnition / photo12v / photoIgnition say what was there.
 * Progress lives entirely in the database now (wiresheet_scrape_combo + wiresheet_vehicle), so a
 * Fargate restart or the weekly run resumes exactly where the last run stopped.
 */
const crawl = async () => {
  const done = await db.loadDoneCombos();        // "make|year|model" keys already finished (was done.json)
  const recorded = await db.loadRecordedKeys();  // "make|year|model|recnum" already scraped (was vehicles.jsonl)

  let pages = 0; // vehicle pages fetched in this run
  let withPhoto = 0; // of those, pages with at least one 12V/ignition photo
  let imagesSaved = 0;

  const makes = (await getMakes()).filter((m) => !ONLY_MAKE || m.toLowerCase() === ONLY_MAKE.toLowerCase());
  console.log(`${makes.length} make(s) to go through. Progress in database (org "${process.env.WIRESHEET_ORG_NAME || "DRIG USA"}").`);

  // Marks an empty level (no years / no models) once, so a rerun does not log it again.
  const noteEmpty = async (make, year, model, state) => {
    const id = `${make}|${year ?? "-"}|${model ?? "-"}`;
    if (done.has(id)) return;
    await db.markCombo(make, year, model, state);
    done.add(id);
  };

  for (const make of makes) {
    const allYears = await getYears(make);
    if (allYears.length === 0) await noteEmpty(make, null, null, "no_years");
    const years = allYears.filter((y) => !ONLY_YEAR || y === ONLY_YEAR);

    for (const year of years) {
      const models = await getModels(make, year);
      if (models.length === 0) await noteEmpty(make, year, null, "no_models");

      for (const model of models) {
        const combo = `${make}|${year}|${model}`;
        if (done.has(combo)) continue;

        const keys = await getKeys(make, year, model);
        if (keys.length === 0) {
          await db.recordVehicle({ make, year, model, status: "no key types" });
          await noteEmpty(make, year, model, "no_keys");
          continue;
        }

        let comboOk = true;
        for (const key of keys) {
          const id = `${make}|${year}|${model}|${key.recnum}`;
          if (recorded.has(id)) continue;
          try {
            const html = await getVehiclePage(make, year, model, key);
            if (SAVE_PAGES) {
              await fs.mkdir(path.join(OUT, "pages"), { recursive: true });
              await fs.writeFile(path.join(OUT, "pages", `${key.recnum}.html`), html);
            }
            const found = parseWires(html);
            const mine = ALL_WIRES ? found : found.filter((w) => IS_12V(w) || IS_IGNITION(w));

            if (WITH_IMAGES) {
              for (const wire of mine) {
                if (!wire.imageUrl) continue;
                const stored = await downloadAndStoreImage(wire.imageUrl);
                if (stored) {
                  wire.imageId = stored.imageId;
                  wire.imageS3Key = stored.s3Key;
                  wire.imageContentHash = stored.contentHash;
                  imagesSaved++;
                }
              }
            }
            for (const wire of mine) wire.circuit = circuitOf(wire);
            const hasPhoto = (w) => Boolean(WITH_IMAGES ? w.imageS3Key : w.imageUrl);
            const flags = {
              found12v: mine.some(IS_12V),
              photo12v: mine.some((w) => IS_12V(w) && hasPhoto(w)),
              foundIgnition: mine.some(IS_IGNITION),
              photoIgnition: mine.some((w) => IS_IGNITION(w) && hasPhoto(w)),
            };
            await db.recordVehicle({
              make, year, model, keyType: key.keyType, recnum: key.recnum, title: parseTitle(html),
              status: found.length === 0 ? "no wire table" : "ok",
              ...flags,
              // --photos-only drops the wires that have no photo from the stored wires (the vehicle row stays).
              wires: PHOTOS_ONLY ? mine.filter(hasPhoto) : mine,
            });
            recorded.add(id);
            pages++;
            if (flags.photo12v || flags.photoIgnition) withPhoto++;

            if (pages % 25 === 0) console.log(`  ${pages} cars looked at, ${withPhoto} with a 12V/ignition photo, ${imagesSaved} images  (now: ${combo})`);
          } catch (err) {
            if (err instanceof LoginError) throw err;
            comboOk = false;
            await db.recordVehicle({ make, year, model, keyType: key.keyType, recnum: key.recnum, status: "error", problem: err.message });
            console.warn(`  failed ${combo} / ${key.keyType}: ${err.message}`);
          }
          if (LIMIT && withPhoto >= LIMIT) {
            console.log(`Stopped at --limit ${LIMIT}: ${withPhoto} car(s) with a 12V/ignition photo found.`);
            return;
          }
          if (MAX_SCAN && pages >= MAX_SCAN) {
            console.log(`Stopped at --max-scan ${MAX_SCAN}: ${withPhoto} car(s) with a 12V/ignition photo found.`);
            return;
          }
        }
        if (comboOk) {
          await db.markCombo(make, year, model, "done");
          done.add(combo);
        }
      }
    }
    console.log(`Finished ${make} (${pages} cars looked at so far)`);
  }
  console.log(`Done: ${pages} cars looked at, ${withPhoto} with a 12V/ignition photo, ${imagesSaved} images saved.`);
};

/** Ctrl+C keeps what was found: the tracker is written before the process exits. */
const saveOnInterrupt = () =>
  process.once("SIGINT", async () => {
    console.log("\nInterrupted: saving the tracker. Run again to resume.");
    await writeReport().catch(() => {});
    process.exit(130);
  });


// ---------------------------------------------------------------------------
// Excel tracker: always rebuilt from the database, so it can never drift from
// the data. Thumbnails are pulled from the qc-wiresheet bucket by their key.
// ---------------------------------------------------------------------------

const THIN = { style: "thin", color: { argb: "FF999999" } };
const MEDIUM = { style: "medium", color: { argb: "FF1F4E78" } };
const FILL = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

/** The same circuit is often listed under several sections (Remote Start, Security): show each option once. */
const uniqueOptions = (wires) => {
  const seen = new Set();
  return wires.filter((w) => {
    const key = [w.function, w.color, w.polarity, w.location, w.imageContentHash ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** "OBD 12 Volts: Violet/Red (+) OBD-Data Link Connector, pin 16 (10A)". */
const describeOption = (w) => `${w.function}: ${[w.color, w.polarity, w.location].filter((part) => part && part.toLowerCase() !== "null").join(" ")}${w.notes ? ` (${w.notes})` : ""}`;

/** The stored thumbnail, fetched from the qc-wiresheet bucket by its key. Null when there is none or S3 can't be reached — the row falls back to a text link. */
const thumbBufferOf = async (option, cache) => {
  if (!option.imageThumbKey) return null;
  if (cache.has(option.imageThumbKey)) return cache.get(option.imageThumbKey);
  let result = null;
  try {
    result = { buffer: await getS3Buffer(option.imageThumbKey), width: option.imageWidth ?? THUMB_WIDTH, height: option.imageHeight ?? THUMB_WIDTH };
  } catch {
    result = null;
  }
  cache.set(option.imageThumbKey, result);
  return result;
};

/** A signed link to the original in S3, valid for REPORT_LINK_DAYS. Null when S3 isn't configured or signing fails. */
const signedUrlFor = async (s3Key) => {
  if (!s3Key) return null;
  try {
    return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: s3Bucket(), Key: s3Key }), { expiresIn: REPORT_LINK_DAYS * 86_400 });
  } catch {
    return null;
  }
};

/**
 * One sheet. A car is a block of rows, one per 12V / ignition option it offers (at least one row):
 *   Make | Year | Model | Key type | 12V | Ignition | 12V option | 12V photo | Ignition option | Ignition photo
 * "12V" and "Ignition" say Found / Not found for the car and repeat on every row of the block so the
 * filters still work. Each option row has its description and, when the site has a photo, a thumbnail
 * that opens the full-size picture. Cars whose page could not be read show "Error"; levels with no car
 * (a make with no years, a year with no models) are not rows.
 */
export const writeReport = async () => {
  await fs.mkdir(OUT, { recursive: true });
  const latest = (await db.loadReportRecords()).filter((v) => v.model); // "no years" / "no models" rows have nothing to list

  // Excel can't reliably render more than ~1000 embedded images in one sheet — past
  // that it shows "image cannot currently be displayed" for the overflow. When the
  // whole dataset would exceed that, every photo becomes a clickable link instead of
  // an embedded thumbnail (a per-make report stays small, so it keeps its thumbnails).
  const EMBED_CAP = 1000;
  const hasPhoto0 = (o) => Boolean(o && o.imageS3Key);
  const photoPlacements = latest.reduce(
    (n, v) =>
      n +
      uniqueOptions((v.wires ?? []).filter((w) => IS_12V_WIRE.test(w.function))).filter(hasPhoto0).length +
      uniqueOptions((v.wires ?? []).filter((w) => IS_IGNITION_WIRE.test(w.function))).filter(hasPhoto0).length,
    0,
  );
  const embedThumbs = photoPlacements <= EMBED_CAP;
  if (!embedThumbs) console.log(`  ${photoPlacements} photos is too many to embed in one sheet (Excel limit ~${EMBED_CAP}); using clickable photo links instead.`);

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Vehicles");
  const headers = ["Make", "Year", "Model", "Key type", "12V", "Ignition", "12V option", "12V photo", "Ignition option", "Ignition photo"];
  sheet.columns = headers.map((header) => ({ header }));
  const thumbs = new Map();
  const imageIds = new Map();

  for (const v of latest) {
    const wires = v.wires ?? [];
    const errored = v.status === "error";
    const read = v.status === "ok";
    const twelve = uniqueOptions(wires.filter((w) => IS_12V_WIRE.test(w.function)));
    const ignition = uniqueOptions(wires.filter((w) => IS_IGNITION_WIRE.test(w.function)));
    // Each row's 12V / Ignition cell describes that row's own option: "Found" only when the site has a photo
    // for it, "Not found on site" for a described wire without one. A row with no option on that side is blank.
    const hasPhoto = (w) => Boolean(w.imageS3Key || w.imageUrl);
    const labelFor = (option, i) =>
      errored ? "Error" : !read ? "Not found on site" : option ? (hasPhoto(option) ? "Found" : "Not found on site") : i === 0 ? "Not found on site" : "";

    const rows = Math.max(1, twelve.length, ignition.length);
    for (let i = 0; i < rows; i++) {
      const options = [twelve[i], ignition[i]];
      const row = sheet.addRow([
        v.make, Number(v.year) || v.year, v.model, v.keyType ?? "", labelFor(twelve[i], i), labelFor(ignition[i], i),
        twelve[i] ? describeOption(twelve[i]) : "", "", ignition[i] ? describeOption(ignition[i]) : "", "",
      ]);

      for (let col = 1; col <= 3; col++) row.getCell(col).fill = FILL(["FFFFF2CC", "FFF4CCCC", "FFD9EAD3"][col - 1]);
      for (const col of [5, 6]) {
        const value = row.getCell(col).value;
        row.getCell(col).fill = FILL(value === "Found" ? "FFC6EFCE" : value === "" ? "FFF2F2F2" : "FFFFC7CE");
      }
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = { top: i === 0 ? MEDIUM : THIN, left: THIN, bottom: THIN, right: THIN };
        const textColumn = col === 7 || col === 9;
        cell.alignment = { vertical: "middle", horizontal: textColumn ? "left" : "center", wrapText: textColumn };
        if (col <= 4) cell.font = { bold: true };
      });

      // The photo of each option: a thumbnail that opens a signed S3 link (expires after REPORT_LINK_DAYS) when clicked.
      let tallest = 0;
      const linkOf = new Map(); // content hash -> signed URL, so one photo shown on several rows is only signed once
      for (const [slot, option] of options.entries()) {
        if (!option) continue;
        const col = slot === 0 ? 8 : 10;
        if (!option.imageS3Key) {
          if (option.imageUrl) row.getCell(col).value = "photo not saved";
          continue;
        }
        if (!linkOf.has(option.imageContentHash)) linkOf.set(option.imageContentHash, await signedUrlFor(option.imageS3Key));
        const link = linkOf.get(option.imageContentHash);
        const thumb = embedThumbs ? await thumbBufferOf(option, thumbs) : null;
        if (!thumb) {
          row.getCell(col).value = link ? { text: "Open photo", hyperlink: link } : "photo in S3 (configure S3 to sign a link)";
          if (link) row.getCell(col).font = { color: { argb: "FF0563C1" }, underline: true };
          continue;
        }
        if (!imageIds.has(option.imageContentHash)) imageIds.set(option.imageContentHash, wb.addImage({ buffer: thumb.buffer, extension: "jpeg" }));
        sheet.addImage(imageIds.get(option.imageContentHash), {
          tl: { col: col - 1 + 0.04, row: row.number - 1 + 0.04 },
          ext: { width: thumb.width, height: thumb.height },
          editAs: "oneCell",
          ...(link && { hyperlinks: { hyperlink: link, tooltip: "Open the full-size photo (link expires)" } }),
        });
        tallest = Math.max(tallest, thumb.height);
      }
      if (tallest > 0) row.height = Math.round(tallest * 0.75) + 8;
      else if (row.getCell(7).value || row.getCell(9).value) row.height = 32;

      // "Found" opens this row's own photo.
      for (const [col, option] of [[5, twelve[i]], [6, ignition[i]]]) {
        const link = option?.imageContentHash ? linkOf.get(option.imageContentHash) : null;
        if (link && row.getCell(col).value === "Found") {
          row.getCell(col).value = { text: "Found", hyperlink: link };
          row.getCell(col).font = { color: { argb: "FF0563C1" }, underline: true, bold: true };
        }
      }
    }
  }

  sheet.columns = [16, 8, 24, 20, 18, 18, 46, 26, 46, 26].map((width, i) => ({ ...sheet.columns[i], width }));
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = FILL("FFFFFF00");
    cell.font = { bold: true, color: { argb: "FF000000" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  const file = path.join(OUT, "tracker.xlsx");
  try {
    await wb.xlsx.writeFile(file);
  } catch (err) {
    // Windows will not overwrite a workbook that is open in Excel.
    if (err.code !== "EBUSY" && err.code !== "EPERM") throw err;
    const alt = path.join(OUT, `tracker-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(alt);
    console.warn(`  tracker.xlsx is open in Excel (${err.code ?? err.message}); wrote ${path.basename(alt)} instead`);
    return alt;
  }
  return file;
};

const main = async () => {
  const parseFile = opt("parse-file", "");
  if (parseFile) {
    const html = await fs.readFile(parseFile, "utf8");
    const wires = parseWires(html);
    console.log("Title:", parseTitle(html));
    console.log(`${wires.length} wires, ${wires.filter((w) => WANTED.test(w.function)).length} kept:`);
    console.log(JSON.stringify(wires.filter((w) => ALL_WIRES || WANTED.test(w.function)), null, 2));
    return;
  }
  if (flag("report")) {
    await db.connect();
    try {
      console.log("Wrote", await writeReport());
    } finally {
      await db.close();
    }
    return;
  }
  // probe checks the site only; the crawl needs the database for progress + the scraped data.
  if (!flag("probe")) await db.connect();
  try {
    await ensureAuth();
    await ensureS3();
    if (!flag("probe")) saveOnInterrupt();
    await (flag("probe") ? probe() : crawl());
    if (!flag("probe")) console.log("Tracker:", await writeReport());
  } catch (err) {
    if (err instanceof LoginError) {
      console.error("The session is not logged in and could not be renewed. Set WIRESHEET_PASSWORD (or a fresh WIRESHEET_COOKIE) and run again: finished combinations are skipped.");
      process.exit(1);
    }
    throw err;
  } finally {
    if (!flag("probe")) await db.close();
  }
};

if (import.meta.url === new URL(process.argv[1], "file://").href || process.argv[1]?.endsWith("scrape.mjs")) await main();
