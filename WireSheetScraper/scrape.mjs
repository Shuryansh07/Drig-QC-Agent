// Exports the "12 Volts" and "Ignition" wires (and their photos) from WireSheet, for every
// make -> year -> model -> key type the site offers. Needs a dealer (subscriber) login.

//   $env:WIRESHEET_PASSWORD = "<your WireSheet dealer password>"     # the scraper logs in and keeps the session
//   # or, instead: $env:WIRESHEET_COOKIE = "<Cookie header copied from a logged-in browser>"
//   node scrape.mjs --probe                  # check login + endpoint shapes, writes nothing
//   node scrape.mjs --make Ford --year 2015   # one slice
//   node scrape.mjs                           # everything (resumes where it stopped)
//   node scrape.mjs --parse-file ../WireSheet.html   # test the parser on a saved page, offline

// Flags: --out <dir> (default data/wiresheet)  --delay <ms> (default 1500)  --no-images
//        --all-wires (keep every wire, not only 12V/ignition)  --dedupe (skip a key profile already fetched)
//        --photos-only (vehicles.jsonl keeps only wires that have a photo)
//        --make <name>  --year <yyyy>  --limit <n> (stop after n cars that have a 12V/ignition photo)  --max-scan <n> (give up after looking at n cars)  --save-pages (keep each car's raw page in <out>/pages for inspection)
//        --report (rebuild tracker.xlsx from what is already saved; no network needed)

// Output (in --out): vehicles.jsonl (one line per vehicle page), images/<recnum>/<file>.jpg,
// done.json (finished make|year|model combinations, so a rerun skips them), errors.jsonl,
// tracker.xlsx (one sheet; a row per 12V/ignition option of each car, with description and clickable photo;
// rebuilt every 500 cars, on Ctrl+C and at the end).
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "node-html-parser";
import ExcelJS from "exceljs";

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
// Images: the photo host is public, so no cookie is sent there
// ---------------------------------------------------------------------------

const downloadImage = async (url, recnum) => {
  const file = path.join("images", recnum, path.basename(new URL(url).pathname));
  const target = path.join(OUT, file);
  try {
    await fs.access(target);
    return file; // already downloaded for another year/model of this profile
  } catch {}
  await fs.mkdir(path.dirname(target), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(Math.max(300, DELAY_MS / 3));
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.ok) {
      await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
      return file;
    }
    if (res && res.status < 500 && res.status !== 429) break; // 404 and the like will not get better
  }
  return null;
};

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};
const appendLine = (file, value) => fs.appendFile(file, `${JSON.stringify(value)}\n`);

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

/**
 * Every filter combination ends up as a line in vehicles.jsonl, whether or not it has data: a car with
 * wires, a car whose page has no wire table, a model with no key types, a year with no models. The
 * `status` says which, and found12v / foundIgnition / photo12v / photoIgnition say what was there.
 */
const crawl = async () => {
  await fs.mkdir(OUT, { recursive: true });
  const doneFile = path.join(OUT, "done.json");
  const done = new Set(await readJson(doneFile, []));
  const vehiclesFile = path.join(OUT, "vehicles.jsonl");
  const record = (rec) => appendLine(vehiclesFile, { ...rec, scrapedAt: new Date().toISOString() });

  // Keys already recorded in an earlier run are not fetched again.
  const recorded = new Set((await readJsonl(vehiclesFile)).filter((v) => v.recnum && v.status !== "error").map((v) => `${v.make}|${v.year}|${v.model}|${v.recnum}`));

  let pages = 0; // vehicle pages fetched in this run
  let withPhoto = 0; // of those, pages with at least one 12V/ignition photo
  let imagesSaved = 0;

  const makes = (await getMakes()).filter((m) => !ONLY_MAKE || m.toLowerCase() === ONLY_MAKE.toLowerCase());
  console.log(`${makes.length} make(s) to go through. Output: ${OUT}`);

  // Marks an empty level (no years / no models) once, so a rerun does not log it again.
  const noteEmpty = async (id, rec) => {
    if (done.has(id)) return;
    await record(rec);
    done.add(id);
    await fs.writeFile(doneFile, JSON.stringify([...done]));
  };

  for (const make of makes) {
    const allYears = await getYears(make);
    if (allYears.length === 0) await noteEmpty(`${make}|-|-`, { make, status: "no years" });
    const years = allYears.filter((y) => !ONLY_YEAR || y === ONLY_YEAR);

    for (const year of years) {
      const models = await getModels(make, year);
      if (models.length === 0) await noteEmpty(`${make}|${year}|-`, { make, year, status: "no models" });

      for (const model of models) {
        const combo = `${make}|${year}|${model}`;
        if (done.has(combo)) continue;

        const keys = await getKeys(make, year, model);
        if (keys.length === 0) await record({ make, year, model, status: "no key types" });

        let comboOk = true;
        for (const key of keys) {
          const id = `${make}|${year}|${model}|${key.recnum}`;
          if ((DEDUPE && recorded.has(id)) || recorded.has(id)) continue;
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
                wire.imageFile = await downloadImage(wire.imageUrl, key.recnum);
                if (wire.imageFile) imagesSaved++;
              }
            }
            const hasPhoto = (w) => Boolean(WITH_IMAGES ? w.imageFile : w.imageUrl);
            const flags = {
              found12v: mine.some(IS_12V),
              photo12v: mine.some((w) => IS_12V(w) && hasPhoto(w)),
              foundIgnition: mine.some(IS_IGNITION),
              photoIgnition: mine.some((w) => IS_IGNITION(w) && hasPhoto(w)),
            };
            await record({
              make, year, model, keyType: key.keyType, recnum: key.recnum, title: parseTitle(html),
              status: found.length === 0 ? "no wire table" : "ok",
              ...flags,
              // --photos-only drops the wires that have no photo from the Wires sheet (the vehicle row stays).
              wires: PHOTOS_ONLY ? mine.filter(hasPhoto) : mine,
            });
            recorded.add(id);
            pages++;
            if (flags.photo12v || flags.photoIgnition) withPhoto++;

            if (pages % 25 === 0) console.log(`  ${pages} cars looked at, ${withPhoto} with a 12V/ignition photo, ${imagesSaved} images  (now: ${combo})`);
            if (pages % 500 === 0) await writeReport();
          } catch (err) {
            if (err instanceof LoginError) throw err;
            comboOk = false;
            await record({ make, year, model, keyType: key.keyType, recnum: key.recnum, status: "error", problem: err.message });
            await appendLine(path.join(OUT, "errors.jsonl"), { make, year, model, key, problem: err.message });
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
          done.add(combo);
          await fs.writeFile(doneFile, JSON.stringify([...done]));
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
// Excel tracker: always rebuilt from vehicles.jsonl + errors.jsonl, so it can never drift from the data
// ---------------------------------------------------------------------------

const readJsonl = async (file) => {
  try {
    return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const THIN = { style: "thin", color: { argb: "FF999999" } };
const MEDIUM = { style: "medium", color: { argb: "FF1F4E78" } };
const FILL = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

const THUMB_WIDTH = 170;

/** The same circuit is often listed under several sections (Remote Start, Security): show each option once. */
const uniqueOptions = (wires) => {
  const seen = new Set();
  return wires.filter((w) => {
    const key = [w.function, w.color, w.polarity, w.location, w.imageFile ?? w.imageUrl ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** "OBD 12 Volts: Violet/Red (+) OBD-Data Link Connector, pin 16 (10A)". */
const describeOption = (w) => `${w.function}: ${[w.color, w.polarity, w.location].filter((part) => part && part.toLowerCase() !== "null").join(" ")}${w.notes ? ` (${w.notes})` : ""}`;

let sharpModule;
const loadSharp = async () => {
  if (sharpModule === undefined) sharpModule = await import("sharp").then((m) => m.default).catch(() => null);
  return sharpModule;
};

/** A small JPEG of a saved photo, so thousands of photos do not make the workbook huge. */
const thumbnailOf = async (file, cache) => {
  if (cache.has(file)) return cache.get(file);
  let result = null;
  try {
    const sharp = await loadSharp();
    if (sharp) {
      const meta = await sharp(file).metadata();
      const width = THUMB_WIDTH;
      const height = Math.max(40, Math.round((meta.height / meta.width) * width));
      result = { buffer: await sharp(file).resize({ width }).jpeg({ quality: 70 }).toBuffer(), width, height };
    }
  } catch {
    result = null; // a missing or unreadable photo: the row says so instead
  }
  cache.set(file, result);
  return result;
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
  // A rerun can log the same car again (after an error): the last line for a car wins.
  const latest = new Map();
  for (const v of await readJsonl(path.join(OUT, "vehicles.jsonl"))) {
    if (!v.model) continue; // "no years" / "no models": nothing to list
    latest.set([v.make, v.year, v.model, v.recnum ?? v.status].join("|"), v);
  }

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Vehicles");
  const headers = ["Make", "Year", "Model", "Key type", "12V", "Ignition", "12V option", "12V photo", "Ignition option", "Ignition photo"];
  sheet.columns = headers.map((header) => ({ header }));
  const thumbs = new Map();
  const imageIds = new Map();

  for (const v of latest.values()) {
    const wires = v.wires ?? [];
    const errored = v.status === "error";
    const read = v.status === "ok";
    const twelve = uniqueOptions(wires.filter((w) => IS_12V_WIRE.test(w.function)));
    const ignition = uniqueOptions(wires.filter((w) => IS_IGNITION_WIRE.test(w.function)));
    // Each row's 12V / Ignition cell describes that row's own option: "Found" only when the site has a photo
    // for it, "Not found on site" for a described wire without one. A row with no option on that side is blank.
    const hasPhoto = (w) => Boolean(w.imageFile || w.imageUrl);
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

      // The photo of each option: a thumbnail that opens the full-size file when clicked.
      let tallest = 0;
      for (const [slot, option] of options.entries()) {
        if (!option) continue;
        const col = slot === 0 ? 8 : 10;
        if (!option.imageFile) {
          if (option.imageUrl) row.getCell(col).value = "photo not saved";
          continue;
        }
        const full = path.join(OUT, option.imageFile);
        const thumb = await thumbnailOf(full, thumbs);
        const link = option.imageFile.replaceAll("\\", "/");
        if (!thumb) {
          row.getCell(col).value = { text: "Open photo", hyperlink: link };
          row.getCell(col).font = { color: { argb: "FF0563C1" }, underline: true };
          continue;
        }
        if (!imageIds.has(full)) imageIds.set(full, wb.addImage({ buffer: thumb.buffer, extension: "jpeg" }));
        sheet.addImage(imageIds.get(full), {
          tl: { col: col - 1 + 0.04, row: row.number - 1 + 0.04 },
          ext: { width: thumb.width, height: thumb.height },
          editAs: "oneCell",
          hyperlinks: { hyperlink: link, tooltip: "Open the full-size photo" },
        });
        tallest = Math.max(tallest, thumb.height);
      }
      if (tallest > 0) row.height = Math.round(tallest * 0.75) + 8;
      else if (row.getCell(7).value || row.getCell(9).value) row.height = 32;

      // "Found" opens this row's own photo.
      for (const [col, option] of [[5, twelve[i]], [6, ignition[i]]]) {
        if (option?.imageFile && row.getCell(col).value === "Found") {
          row.getCell(col).value = { text: "Found", hyperlink: option.imageFile.replaceAll("\\", "/") };
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
    console.log("Wrote", await writeReport());
    return;
  }
  try {
    await ensureAuth();
    if (!flag("probe")) saveOnInterrupt();
    await (flag("probe") ? probe() : crawl());
    if (!flag("probe")) console.log("Tracker:", await writeReport());
  } catch (err) {
    if (err instanceof LoginError) {
      console.error("The session is not logged in and could not be renewed. Set WIRESHEET_PASSWORD (or a fresh WIRESHEET_COOKIE) and run again: finished combinations are skipped.");
      process.exit(1);
    }
    throw err;
  }
};

if (import.meta.url === new URL(process.argv[1], "file://").href || process.argv[1]?.endsWith("scrape.mjs")) await main();
